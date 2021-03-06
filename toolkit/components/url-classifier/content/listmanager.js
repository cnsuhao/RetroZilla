/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Google Safe Browsing.
 *
 * The Initial Developer of the Original Code is Google Inc.
 * Portions created by the Initial Developer are Copyright (C) 2006
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Niels Provos <niels@google.com> (original author)
 *   Fritz Schneider <fritz@google.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */


// A class that manages lists, namely white and black lists for
// phishing or malware protection. The ListManager knows how to fetch,
// update, and store lists, and knows the "kind" of list each is (is
// it a whitelist? a blacklist? etc). However it doesn't know how the
// lists are serialized or deserialized (the wireformat classes know
// this) nor the specific format of each list. For example, the list
// could be a map of domains to "1" if the domain is phishy. Or it
// could be a map of hosts to regular expressions to match, who knows?
// Answer: the trtable knows. List are serialized/deserialized by the
// wireformat reader from/to trtables, and queried by the listmanager.
//
// There is a single listmanager for the whole application.
//
// The listmanager is used only in privacy mode; in advanced protection
// mode a remote server is queried.
//
// How to add a new table:
// 1) get it up on the server
// 2) add it to tablesKnown
// 3) if it is not a known table type (trtable.js), add an implementation
//    for it in trtable.js
// 4) add a check for it in the phishwarden's isXY() method, for example
//    isBlackURL()
//
// TODO: obviously the way this works could use a lot of improvement. In
//       particular adding a list should just be a matter of adding
//       its name to the listmanager and an implementation to trtable
//       (or not if a talbe of that type exists). The format and semantics
//       of the list comprise its name, so the listmanager should easily
//       be able to figure out what to do with what list (i.e., no
//       need for step 4).
// TODO more comprehensive update tests, for example add unittest check 
//      that the listmanagers tables are properly written on updates

/**
 * The base pref name for where we keep table version numbers.
 * We add append the table name to this and set the value to
 * the version.  E.g., tableversion.goog-black-enchash may have
 * a value of 1.1234.
 */
const kTableVersionPrefPrefix = "urlclassifier.tableversion.";

// How frequently we check for updates (30 minutes)
const kUpdateInterval = 30 * 60 * 1000;

/**
 * A ListManager keeps track of black and white lists and knows
 * how to update them.
 *
 * @constructor
 */
function PROT_ListManager() {
  this.debugZone = "listmanager";
  G_debugService.enableZone(this.debugZone);

  this.currentUpdateChecker_ = null;   // set when we toggle updates
  this.prefs_ = new G_Preferences();

  this.updateserverURL_ = null;

  // The lists we know about and the parses we can use to read
  // them. Default all to the earlies possible version (1.-1); this
  // version will get updated when successfully read from disk or
  // fetch updates.
  this.tablesKnown_ = {};
  this.isTesting_ = false;
  
  if (this.isTesting_) {
    // populate with some tables for unittesting
    this.tablesKnown_ = {
      // A major version of zero means local, so don't ask for updates       
      "test1-foo-domain" : new PROT_VersionParser("test1-foo-domain", 0, -1),
      "test2-foo-domain" : new PROT_VersionParser("test2-foo-domain", 0, -1),
      "test-white-domain" : 
        new PROT_VersionParser("test-white-domain", 0, -1, true /* require mac*/),
      "test-mac-domain" :
        new PROT_VersionParser("test-mac-domain", 0, -1, true /* require mac */)
    };
    
    // expose the object for unittesting
    this.wrappedJSObject = this;
  }

  this.tablesData = {};

  this.observerServiceObserver_ = new G_ObserverServiceObserver(
                                          'xpcom-shutdown',
                                          BindToObject(this.shutdown_, this),
                                          true /*only once*/);

  // Lazily create urlCrypto (see tr-fetcher.js)
  this.urlCrypto_ = null;
  
  this.requestBackoff_ = new RequestBackoff(3 /* num errors */,
                                   10*60*1000 /* error time, 10min */,
                                   60*60*1000 /* backoff interval, 60min */,
                                   6*60*60*1000 /* max backoff, 6hr */);
}

/**
 * xpcom-shutdown callback
 * Delete all of our data tables which seem to leak otherwise.
 */
PROT_ListManager.prototype.shutdown_ = function() {
  for (var name in this.tablesData) {
    delete this.tablesData[name];
  }
}

/**
 * Set the url we check for updates.  If the new url is valid and different,
 * update our table list.
 * 
 * After setting the update url, the caller is responsible for registering
 * tables and then toggling update checking.  All the code for this logic is
 * currently in browser/components/safebrowsing.  Maybe it should be part of
 * the listmanger?
 */
PROT_ListManager.prototype.setUpdateUrl = function(url) {
  G_Debug(this, "Set update url: " + url);
  if (url != this.updateserverURL_) {
    this.updateserverURL_ = url;
    this.requestBackoff_.reset();
    
    // Remove old tables which probably aren't valid for the new provider.
    for (var name in this.tablesData) {
      delete this.tablesData[name];
      delete this.tablesKnown_[name];
    }
  }
}

/**
 * Set the crypto key url.
 * @param url String
 */
PROT_ListManager.prototype.setKeyUrl = function(url) {
  G_Debug(this, "Set key url: " + url);
  if (!this.urlCrypto_)
    this.urlCrypto_ = new PROT_UrlCrypto();
  
  this.urlCrypto_.manager_.setKeyUrl(url);
}

/**
 * Register a new table table
 * @param tableName - the name of the table
 * @param opt_requireMac true if a mac is required on update, false otherwise
 * @returns true if the table could be created; false otherwise
 */
PROT_ListManager.prototype.registerTable = function(tableName, 
                                                    opt_requireMac) {
  var table = new PROT_VersionParser(tableName, 1, -1, opt_requireMac);
  if (!table)
    return false;
  this.tablesKnown_[tableName] = table;
  this.tablesData[tableName] = newUrlClassifierTable(tableName);

  return true;
}

/**
 * Enable updates for some tables
 * @param tables - an array of table names that need updating
 */
PROT_ListManager.prototype.enableUpdate = function(tableName) {
  var changed = false;
  var table = this.tablesKnown_[tableName];
  if (table) {
    G_Debug(this, "Enabling table updates for " + tableName);
    table.needsUpdate = true;
    changed = true;
  }

  if (changed === true)
    this.maybeToggleUpdateChecking();
}

/**
 * Disables updates for some tables
 * @param tables - an array of table names that no longer need updating
 */
PROT_ListManager.prototype.disableUpdate = function(tableName) {
  var changed = false;
  var table = this.tablesKnown_[tableName];
  if (table) {
    G_Debug(this, "Disabling table updates for " + tableName);
    table.needsUpdate = false;
    changed = true;
  }

  if (changed === true)
    this.maybeToggleUpdateChecking();
}

/**
 * Determine if we have some tables that need updating.
 */
PROT_ListManager.prototype.requireTableUpdates = function() {
  for (var type in this.tablesKnown_) {
    // All tables with a major of 0 are internal tables that we never
    // update remotely.
    if (this.tablesKnown_[type].major == 0)
      continue;
     
    // Tables that need updating even if other tables dont require it
    if (this.tablesKnown_[type].needsUpdate)
      return true;
  }

  return false;
}

/**
 * Start managing the lists we know about. We don't do this automatically
 * when the listmanager is instantiated because their profile directory
 * (where we store the lists) might not be available.
 */
PROT_ListManager.prototype.maybeStartManagingUpdates = function() {
  if (this.isTesting_)
    return;

  // We might have been told about tables already, so see if we should be
  // actually updating.
  this.maybeToggleUpdateChecking();
}

/**
 * Determine if we have any tables that require updating.  Different
 * Wardens may call us with new tables that need to be updated.
 */ 
PROT_ListManager.prototype.maybeToggleUpdateChecking = function() {
  // If we are testing or dont have an application directory yet, we should
  // not start reading tables from disk or schedule remote updates
  if (this.isTesting_)
    return;

  // We update tables if we have some tables that want updates.  If there
  // are no tables that want to be updated - we dont need to check anything.
  if (this.requireTableUpdates() === true) {
    G_Debug(this, "Starting managing lists");
    this.startUpdateChecker();

    // Multiple warden can ask us to reenable updates at the same time, but we
    // really just need to schedule a single update.
    if (!this.currentUpdateChecker_) {
      // If the user has never downloaded tables, do the check now.
      // If the user has tables, add a fuzz of a few minutes.
      this.loadTableVersions_();
      var hasTables = false;
      for (var table in this.tablesKnown_) {
        if (this.tablesKnown_[table].minor != -1) {
          hasTables = true;
          break;
        }
      }

      var initialUpdateDelay = 3000;
      if (hasTables) {
        // Add a fuzz of 0-5 minutes.
        initialUpdateDelay += Math.floor(Math.random() * (5 * 60 * 1000));
      }
      this.currentUpdateChecker_ =
        new G_Alarm(BindToObject(this.checkForUpdates, this),
                    initialUpdateDelay);
    }
  } else {
    G_Debug(this, "Stopping managing lists (if currently active)");
    this.stopUpdateChecker();                    // Cancel pending updates
  }
}

/**
 * Start periodic checks for updates. Idempotent.
 * We want to distribute update checks evenly across the update period (an
 * hour).  To do this, we pick a random number of time between 0 and 30
 * minutes.  The client first checks at 15 + rand, then every 30 minutes after
 * that.
 */
PROT_ListManager.prototype.startUpdateChecker = function() {
  this.stopUpdateChecker();
  
  // Schedule the first check for between 15 and 45 minutes.
  var repeatingUpdateDelay = kUpdateInterval / 2;
  repeatingUpdateDelay += Math.floor(Math.random() * kUpdateInterval);
  this.updateChecker_ = new G_Alarm(BindToObject(this.initialUpdateCheck_,
                                                 this),
                                    repeatingUpdateDelay);
}

/**
 * Callback for the first update check.
 * We go ahead and check for table updates, then start a regular timer (once
 * every 30 minutes).
 */
PROT_ListManager.prototype.initialUpdateCheck_ = function() {
  this.checkForUpdates();
  this.updateChecker_ = new G_Alarm(BindToObject(this.checkForUpdates, this), 
                                    kUpdateInterval, true /* repeat */);
}

/**
 * Stop checking for updates. Idempotent.
 */
PROT_ListManager.prototype.stopUpdateChecker = function() {
  if (this.updateChecker_) {
    this.updateChecker_.cancel();
    this.updateChecker_ = null;
  }
  // Cancel the oneoff check from maybeToggleUpdateChecking.
  if (this.currentUpdateChecker_) {
    this.currentUpdateChecker_.cancel();
    this.currentUpdateChecker_ = null;
  }
}

/**
 * Provides an exception free way to look up the data in a table. We
 * use this because at certain points our tables might not be loaded,
 * and querying them could throw.
 *
 * @param table String Name of the table that we want to consult
 * @param key String Key for table lookup
 * @param callback nsIUrlListManagerCallback (ie., Function) given false or the
 *        value in the table corresponding to key.  If the table name does not
 *        exist, we return false, too.
 */
PROT_ListManager.prototype.safeExists = function(table, key, callback) {
  try {
    G_Debug(this, "safeExists: " + table + ", " + key);
    var map = this.tablesData[table];
    map.exists(key, callback);
  } catch(e) {
    G_Debug(this, "safeExists masked failure for " + table + ", key " + key + ": " + e);
    callback.handleEvent(false);
  }
}

/**
 * We store table versions in user prefs.  This method pulls the values out of
 * the user prefs and into the tablesKnown objects.
 */
PROT_ListManager.prototype.loadTableVersions_ = function() {
  // Pull values out of prefs.
  var prefBase = kTableVersionPrefPrefix;
  for (var table in this.tablesKnown_) {
    var version = this.prefs_.getPref(prefBase + table, "1.-1");
    G_Debug(this, "loadTableVersion " + table + ": " + version);
    var tokens = version.split(".");
    G_Assert(this, tokens.length == 2, "invalid version number");
    
    this.tablesKnown_[table].major = tokens[0];
    this.tablesKnown_[table].minor = tokens[1];
  }
}

/**
 * Callback from db update service.  As new tables are added to the db,
 * this callback is fired so we can update the version number.
 * @param versionString String containing the table update response from the
 *        server
 */
PROT_ListManager.prototype.setTableVersion_ = function(versionString) {
  G_Debug(this, "Got version string: " + versionString);
  var versionParser = new PROT_VersionParser("");
  if (versionParser.fromString(versionString)) {
    var tableName = versionParser.type;
    var versionNumber = versionParser.versionString();
    var prefBase = kTableVersionPrefPrefix;

    this.prefs_.setPref(prefBase + tableName, versionNumber);
    
    if (!this.tablesKnown_[tableName]) {
      this.tablesKnown_[tableName] = versionParser;
    } else {
      this.tablesKnown_[tableName].ImportVersion(versionParser);
    }
    
    if (!this.tablesData[tableName])
      this.tablesData[tableName] = newUrlClassifierTable(tableName);
  }

  // Since this is called from the update server, it means there was
  // a successful http request.  Make sure to notify the request backoff
  // object.
  this.requestBackoff_.noteServerResponse(200 /* ok */);
}

/**
 * Prepares a URL to fetch upates from. Format is a squence of 
 * type:major:minor, fields
 * 
 * @param url The base URL to which query parameters are appended; assumes
 *            already has a trailing ?
 * @returns the URL that we should request the table update from.
 */
PROT_ListManager.prototype.getRequestURL_ = function(url) {
  url += "version=";
  var firstElement = true;
  var requestMac = false;

  for (var type in this.tablesKnown_) {
    // All tables with a major of 0 are internal tables that we never
    // update remotely.
    if (this.tablesKnown_[type].major == 0)
      continue;

    // Check if the table needs updating
    if (this.tablesKnown_[type].needsUpdate == false)
      continue;

    if (!firstElement) {
      url += ","
    } else {
      firstElement = false;
    }
    url += type + ":" + this.tablesKnown_[type].toUrl();

    if (this.tablesKnown_[type].requireMac)
      requestMac = true;
  }

  // Request a mac only if at least one of the tables to be updated requires
  // it
  if (requestMac) {
    // Add the wrapped key for requesting macs
    if (!this.urlCrypto_)
      this.urlCrypto_ = new PROT_UrlCrypto();

    url += "&wrkey=" +
      encodeURIComponent(this.urlCrypto_.getManager().getWrappedKey());
  }

  G_Debug(this, "getRequestURL returning: " + url);
  return url;
}

/**
 * Updates our internal tables from the update server
 *
 * @returns true when a new request was scheduled, false if an old request
 *          was still pending.
 */
PROT_ListManager.prototype.checkForUpdates = function() {
  // Allow new updates to be scheduled from maybeToggleUpdateChecking()
  this.currentUpdateChecker_ = null;

  if (!this.updateserverURL_) {
    G_Debug(this, 'checkForUpdates: no update server url');
    return false;
  }

  // See if we've triggered the request backoff logic.
  if (!this.requestBackoff_.canMakeRequest())
    return false;

  // Check to make sure our tables still exist (maybe the db got corrupted or
  // the user deleted the file).  If not, we need to reset the table version
  // before sending the update check.
  var tableNames = [];
  for (var tableName in this.tablesKnown_) {
    tableNames.push(tableName);
  }
  var dbService = Cc["@mozilla.org/url-classifier/dbservice;1"]
                  .getService(Ci.nsIUrlClassifierDBService);
  dbService.checkTables(tableNames.join(","),
                        BindToObject(this.makeUpdateRequest_, this));
  return true;
}

/**
 * Method that fires the actual HTTP update request.
 * First we reset any tables that have disappeared.
 * @param tableNames String comma separated list of tables that
 *   don't exist
 */
PROT_ListManager.prototype.makeUpdateRequest_ = function(tableNames) {
  // Clear prefs that track table version if they no longer exist in the db.
  var tables = tableNames.split(",");
  for (var i = 0; i < tables.length; ++i) {
    G_Debug(this, "Table |" + tables[i] + "| no longer exists, clearing pref.");
    this.prefs_.clearPref(kTableVersionPrefPrefix + tables[i]);
  }

  // Ok, now reload the table version.
  this.loadTableVersions_();

  G_Debug(this, 'checkForUpdates: scheduling request..');
  var url = this.getRequestURL_(this.updateserverURL_);
  var streamer = Cc["@mozilla.org/url-classifier/streamupdater;1"]
                 .getService(Ci.nsIUrlClassifierStreamUpdater);
  try {
    streamer.updateUrl = url;
  } catch (e) {
    G_Debug(this, 'invalid url');
    return;
  }

  if (!streamer.downloadUpdates(BindToObject(this.setTableVersion_, this),
                                BindToObject(this.downloadError_, this))) {
    G_Debug(this, "pending update, wait until later");
  }
}

/**
 * Callback function if there's a download error.
 * @param status String http status or an empty string if connection refused.
 */
PROT_ListManager.prototype.downloadError_ = function(status) {
  G_Debug(this, "download error: " + status);
  // If status is empty, then we assume that we got an NS_CONNECTION_REFUSED
  // error.  In this case, we treat this is a http 500 error.
  if (!status) {
    status = 500;
  }
  status = parseInt(status, 10);
  this.requestBackoff_.noteServerResponse(status);

  // Try again in a minute
  this.currentUpdateChecker_ =
    new G_Alarm(BindToObject(this.checkForUpdates, this), 60000);
}

PROT_ListManager.prototype.QueryInterface = function(iid) {
  if (iid.equals(Ci.nsISupports) ||
      iid.equals(Ci.nsIUrlListManager) ||
      iid.equals(Ci.nsITimerCallback))
    return this;

  Components.returnCode = Components.results.NS_ERROR_NO_INTERFACE;
  return null;
}

// A simple factory function that creates nsIUrlClassifierTable instances based
// on a name.  The name is a string of the format
// provider_name-semantic_type-table_type.  For example, goog-white-enchash
// or goog-black-url.
function newUrlClassifierTable(name) {
  G_Debug("protfactory", "Creating a new nsIUrlClassifierTable: " + name);
  var tokens = name.split('-');
  var type = tokens[2];
  var table = Cc['@mozilla.org/url-classifier/table;1?type=' + type]
                .createInstance(Ci.nsIUrlClassifierTable);
  table.name = name;
  return table;
}

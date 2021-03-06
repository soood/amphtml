/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {dev, user} from './log';
import {isExperimentOn} from './experiments';
import {Services} from './services';
import {
  isProxyOrigin,
  parseUrl,
  parseQueryString,
  addParamsToUrl,
} from './url';
import {getMode} from './mode';

const TIMEOUT_VALUE = 8000;

let trackImpressionPromise = null;

/**
 * A function to get the trackImpressionPromise;
 * @return {!Promise}
 */
export function getTrackImpressionPromise() {
  return dev().assert(trackImpressionPromise);
}

/**
 * Function that reset the trackImpressionPromise only for testing
 * @visibleForTesting
 */
export function resetTrackImpressionPromiseForTesting() {
  trackImpressionPromise = null;
}

/**
 * Emit a HTTP request to a destination defined on the incoming URL.
 * Launched for trusted viewer. Otherwise guarded by experiment.
 * @param {!Window} win
 */
export function maybeTrackImpression(win) {
  let resolveImpression;

  const promise = new Promise(resolve => {
    resolveImpression = resolve;
  });

  trackImpressionPromise = Services.timerFor(win).timeoutPromise(TIMEOUT_VALUE,
      promise, 'TrackImpressionPromise timeout').catch(error => {
        dev().warn('IMPRESSION', error);
      });

  const viewer = Services.viewerForDoc(win.document);
  const isTrustedViewerPromise = viewer.isTrustedViewer();
  const isTrustedReferrerPromise = viewer.isTrustedReferrer();
  Promise.all([
    isTrustedViewerPromise,
    isTrustedReferrerPromise,
  ]).then(results => {
    const isTrustedViewer = results[0];
    const isTrustedReferrer = results[1];
    // Currently this feature is launched for trusted viewer and trusted referrer,
    // but still experiment guarded for all AMP docs.
    if (!isTrustedViewer && !isTrustedReferrer && !isExperimentOn(win, 'alp')) {
      resolveImpression();
      return;
    }

    const replaceUrlPromise = handleReplaceUrl(win);
    const clickUrlPromise = handleClickUrl(win);

    Promise.all([replaceUrlPromise, clickUrlPromise]).then(() => {
      resolveImpression();
    }, () => {});
  });
}

/**
 * Signal that impression tracking is not relevant in this environment.
 */
export function doNotTrackImpression() {
  trackImpressionPromise = Promise.resolve();
}

/**
 * Handle the getReplaceUrl and return a promise when url is replaced
 * Only handles replaceUrl when viewer indicates AMP to do so. Viewer should indicate
 * by setting the legacy replaceUrl init param and add `replaceUrl` to its capability param.
 * Future plan is to change the type of legacy init replaceUrl param from url string
 * to boolean value.
 * Please NOTE replaceUrl and adLocation will never arrive at same time,
 * so there is no race condition on the order of handling url replacement.
 * @param {!Window} win
 * @return {!Promise}
 */
function handleReplaceUrl(win) {
  const viewer = Services.viewerForDoc(win.document);

  // ReplaceUrl substitution doesn't have to wait until the document is visible
  if (!viewer.getParam('replaceUrl')) {
    // The init replaceUrl param serve as a signal on whether replaceUrl is
    // required for this doc.
    return Promise.resolve();
  }

  if (!viewer.hasCapability('replaceUrl')) {
    // If Viewer is not capability of providing async replaceUrl, use the legacy
    // init replaceUrl param.
    viewer.replaceUrl(viewer.getParam('replaceUrl') || null);
    return Promise.resolve();
  }

  // request async replaceUrl is viewer support getReplaceUrl.
  return viewer.sendMessageAwaitResponse('getReplaceUrl', /* data */ undefined)
      .then(response => {
        if (!response || typeof response != 'object') {
          dev().warn('IMPRESSION', 'get invalid replaceUrl response');
          return;
        }
        viewer.replaceUrl(response['replaceUrl'] || null);
      }, err => {
        dev().warn('IMPRESSION', 'Error request replaceUrl from viewer', err);
      });
}


/**
 * Perform the impression request if it has been provided via
 * the click param in the viewer arguments. Returns a promise.
 * @param {!Window} win
 * @return {!Promise}
 */
function handleClickUrl(win) {
  const viewer = Services.viewerForDoc(win.document);
  /** @const {string|undefined} */
  const clickUrl = viewer.getParam('click');

  if (!clickUrl) {
    return Promise.resolve();
  }

  if (clickUrl.indexOf('https://') != 0) {
    user().warn('IMPRESSION',
        'click fragment param should start with https://. Found ',
        clickUrl);
    return Promise.resolve();
  }

  if (win.location.hash) {
    // This is typically done using replaceState inside the viewer.
    // If for some reason it failed, get rid of the fragment here to
    // avoid duplicate tracking.
    win.location.hash = '';
  }

    // TODO(@zhouyx) need test with a real response.
  return viewer.whenFirstVisible().then(() => {
    return invoke(win, dev().assertString(clickUrl));
  }).then(response => {
    applyResponse(win, response);
  });
}

/**
 * Send the url to ad server and wait for its response
 * @param {!Window} win
 * @param {string} clickUrl
 * @return {!Promise<!JsonObject>}
 */
function invoke(win, clickUrl) {
  if (getMode().localDev && !getMode().test) {
    clickUrl = 'http://localhost:8000/impression-proxy?url=' + clickUrl;
  }
  return Services.xhrFor(win).fetchJson(clickUrl, {
    credentials: 'include',
    // All origins are allows to send these requests.
    requireAmpResponseSourceOrigin: false,
  }).then(res => res.json());
}

/**
 * parse the response back from ad server
 * Set for analytics purposes
 * @param {!Window} win
 * @param {!JsonObject} response
 */
function applyResponse(win, response) {
  const adLocation = response['location'];
  const adTracking = response['tracking_url'];

  // If there is a tracking_url, need to track it
  // Otherwise track the location
  const trackUrl = adTracking || adLocation;

  if (trackUrl && !isProxyOrigin(trackUrl)) {
    // To request the provided trackUrl for tracking purposes.
    new Image().src = trackUrl;
  }

  // Replace the location href params with new location params we get (if any).
  if (adLocation) {
    if (!win.history.replaceState) {
      return;
    }

    const currentHref = win.location.href;
    const url = parseUrl(adLocation);
    const params = parseQueryString(url.search);
    const newHref = addParamsToUrl(currentHref, params);
    win.history.replaceState(null, '', newHref);
  }
}

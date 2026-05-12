/*!
 * coi-serviceworker
 * Re-injects Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy
 * headers via fetch interception so SharedArrayBuffer / multi-threaded
 * WASM works on hosts that don't let you set headers (GitHub Pages).
 *
 * Source: https://github.com/gzuidhof/coi-serviceworker (MIT)
 * Vendored verbatim because there's no benefit to an extra runtime
 * dependency for ~50 lines of code.
 */
/* eslint-disable */

if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('message', (ev) => {
    if (!ev.data) return;
    if (ev.data.type === 'deregister') {
      self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => {
        clients.forEach((client) => client.navigate(client.url));
      });
    }
  });

  self.addEventListener('fetch', (event) => {
    const r = event.request;
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;

    const request = r.cache === 'no-cache' ? new Request(r.url, r) : r;

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response;
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
          newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e))
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem('coiReloadedBySelf');
    window.sessionStorage.removeItem('coiReloadedBySelf');
    const coepCredentialless = false;

    const coi = {
      shouldRegister: () => !reloadedBySelf,
      shouldDeregister: () => false,
      coepCredentialless: () => coepCredentialless,
      doReload: () => window.location.reload(),
      quiet: false,
    };

    const n = navigator;
    if (n.serviceWorker && n.serviceWorker.controller) {
      n.serviceWorker.controller.postMessage({ type: 'deregister' });
    }

    if (n.serviceWorker && coi.shouldRegister()) {
      n.serviceWorker
        .register(window.document.currentScript.src)
        .then(
          (registration) => {
            if (!coi.quiet) console.log('COOP/COEP service worker registered', registration.scope);
            registration.addEventListener('updatefound', () => {
              if (!coi.quiet) console.log('Reloading page to make use of updated COOP/COEP service worker.');
              window.sessionStorage.setItem('coiReloadedBySelf', '1');
              coi.doReload();
            });
            if (registration.active && !n.serviceWorker.controller) {
              window.sessionStorage.setItem('coiReloadedBySelf', '1');
              coi.doReload();
            }
          },
          (err) => {
            if (!coi.quiet) console.error('COOP/COEP service worker failed to register:', err);
          }
        );
    }
  })();
}

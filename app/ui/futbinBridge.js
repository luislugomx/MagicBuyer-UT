// FUTBIN bridge: if a direct request is blocked (Cloudflare), the FUTBIN page is opened
// in a hidden iframe. The script also runs on futbin.com: inside the iframe, it sends
// the page's HTML (or JSON) back to the web app via postMessage. No data is modified.

const MSG = "MB_FUTBIN";
const EA_ORIGIN = "https://www.ea.com";
const FUTBIN_ORIGINS = ["https://www.futbin.com", "https://futbin.com"];

export const isFutbinPage = () => {
  try {
    return /(^|\.)futbin\.com$/i.test(location.hostname);
  } catch (e) {
    return false;
  }
};

const isFramed = () => {
  try {
    return window.parent && window.parent !== window;
  } catch (e) {
    return true;
  }
};

// The HTML is only sent to the EA web app (never to another site embedding FUTBIN in an iframe).
const postToParent = (payload) => {
  try {
    window.parent.postMessage(Object.assign({ source: MSG }, payload), EA_ORIGIN);
  } catch (e) {}
};

const framedByEa = () => {
  try {
    const ancestors = location.ancestorOrigins;
    return !ancestors || !ancestors.length || ancestors[0] === EA_ORIGIN;
  } catch (e) {
    return false;
  }
};

const bodyText = () =>
  (document.body && (document.body.innerText || document.body.textContent)) || "";

// Waits until the page has actually loaded its content (prices, squad cards).
const pageReady = () => {
  const path = location.pathname;
  if (/\/player\//.test(path)) {
    return !!document.querySelector(".price-box [class*='lowest-price']");
  }
  if (/squad|sbc/i.test(path)) {
    // Squad provided as JSON in the page (React render): ready as soon as that JSON is there.
    return (
      !!document.querySelector("script[data-react-data]") ||
      document.querySelectorAll("img[src*='/players/']").length >= 11
    );
  }
  return document.readyState === "complete";
};

export const bootFutbinBridge = () => {
  if (!isFutbinPage() || !isFramed() || !framedByEa() || window.__mbFutbinBridge) {
    return;
  }
  window.__mbFutbinBridge = true;
  let sent = false;
  const send = () => {
    if (sent) {
      return;
    }
    sent = true;
    const text = bodyText().trim();
    if (text && (text[0] === "[" || text[0] === "{")) {
      postToParent({ kind: "json", url: location.href, text });
      return;
    }
    postToParent({
      kind: "html",
      url: location.href,
      text: document.documentElement ? document.documentElement.outerHTML : "",
    });
  };
  let tries = 0;
  const tick = () => {
    tries += 1;
    if (pageReady() || tries >= 40) {
      send();
      return true;
    }
    return false;
  };
  const start = () => {
    if (!tick()) {
      const timer = setInterval(() => {
        if (tick()) {
          clearInterval(timer);
        }
      }, 250);
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
};

let chain = Promise.resolve();

// Loads a FUTBIN URL in a hidden iframe and returns { kind, url, text } or null.
export const fetchViaIframe = (url, timeoutMs = 15000) => {
  chain = chain
    .catch(() => {})
    .then(
      () =>
        new Promise((resolve) => {
          if (typeof document === "undefined" || !document.body) {
            resolve(null);
            return;
          }
          const iframe = document.createElement("iframe");
          iframe.setAttribute("data-mb-futbin", "1");
          iframe.setAttribute("aria-hidden", "true");
          iframe.style.cssText =
            "position:fixed;width:1px;height:1px;left:-9999px;bottom:0;opacity:0;pointer-events:none;border:0";
          let done = false;
          const finish = (payload) => {
            if (done) {
              return;
            }
            done = true;
            window.removeEventListener("message", onMessage);
            clearTimeout(timer);
            if (iframe.parentNode) {
              iframe.parentNode.removeChild(iframe);
            }
            resolve(payload);
          };
          const onMessage = (event) => {
            const data = event && event.data;
            if (
              data &&
              data.source === MSG &&
              event.source === iframe.contentWindow &&
              FUTBIN_ORIGINS.includes(event.origin)
            ) {
              finish({ kind: data.kind, url: data.url, text: String(data.text || "") });
            }
          };
          const timer = setTimeout(() => finish(null), timeoutMs);
          window.addEventListener("message", onMessage);
          // Page refused in an iframe (X-Frame-Options): loading ends without a message.
          iframe.addEventListener("load", () => setTimeout(() => finish(null), 4000));
          iframe.src = url;
          document.body.appendChild(iframe);
        })
    );
  return chain;
};

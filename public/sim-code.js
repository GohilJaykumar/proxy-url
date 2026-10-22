/* ──────────────────────────────────────────────────────────────
   Sim-Code profile icon.

   Renders a fixed pill in the top-right corner showing the code this
   browser uses, and fills every [data-sim-code] element on the page
   with the same value so the docs can show the reader their own code
   instead of a placeholder.

   The code is read from localStorage when it is already there, and
   otherwise issued by GET /api/session and stored — the same key and
   the same logic the manager UI uses, so the two always agree.

   Browser users never have to do anything with this: the UI already
   sends the header on their behalf. The pill exists so the value can
   be copied into terminal and CI commands.
   ────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var STORAGE_KEY = "proxy_sim_user_code";
  var SHORT_LEN = 11;
  var COPY_FEEDBACK_MS = 1600;

  /* A code is only valid if the server signed it, so it cannot be invented
     here. When the request fails we keep retrying instead of giving up -
     the pill must never settle on a dead end. */
  var RETRY_DELAYS_MS = [400, 900, 2000, 4000];
  var RETRY_CAP_MS = 8000;

  var fab = null;
  var pendingRequest = null;   /* de-dupes concurrent callers */
  var retryTimer = null;
  var failedAttempts = 0;

  /* The manager UI treats ?role=admin as its own identity and never stores a
     code for it. Mirror that here: no code is issued and no pill is shown. */
  var isAdmin = new URLSearchParams(window.location.search).get("role") === "admin";

  var code = "";

  function readStored() {
    try {
      return localStorage.getItem(STORAGE_KEY) || "";
    } catch (error) {
      return ""; /* private mode, or storage blocked */
    }
  }

  function writeStored(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      /* Nothing to do — the code still works for this page load. */
    }
  }

  /* One round trip. Sending an existing code has it echoed back rather than
     replaced, so a returning visitor keeps the code they already used. */
  function requestCode() {
    var stored = readStored();
    var options = stored ? { headers: { "x-user-code": stored } } : {};

    return fetch("/api/session", options)
      .then(function (response) {
        if (!response.ok) throw new Error("/api/session returned " + response.status);
        return response.json();
      })
      .then(function (body) {
        if (!body || !body.user_code) throw new Error("/api/session returned no code");
        code = body.user_code;
        writeStored(code);
        return code;
      });
  }

  function retryDelay() {
    var index = Math.min(failedAttempts, RETRY_DELAYS_MS.length - 1);
    return Math.min(RETRY_DELAYS_MS[index], RETRY_CAP_MS);
  }

  /* localStorage first so a known code shows instantly, then confirm it with
     the server. Without one, keep asking until a code is issued. */
  function resolveCode() {
    if (isAdmin) {
      code = "admin";
      return Promise.resolve(code);
    }
    if (pendingRequest) return pendingRequest;

    code = readStored();

    pendingRequest = new Promise(function (resolve) {
      (function attempt() {
        retryTimer = null;

        requestCode()
          .then(function (value) {
            failedAttempts = 0;
            update();
            resolve(value);
          })
          .catch(function (error) {
            failedAttempts += 1;
            console.warn("[Sim-Code] could not reach the server", error);

            /* A stored code still works - carry on with it and stop asking. */
            if (code) {
              update();
              resolve(code);
              return;
            }

            /* Nothing to fall back on: show progress and try again. */
            update();
            retryTimer = setTimeout(attempt, retryDelay());
          });
      })();
    });

    return pendingRequest;
  }

  /* Used by the pill when someone taps it while a code is still missing. */
  function retryNow() {
    if (code || retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    failedAttempts = 0;
    update();
    pendingRequest = null;
    resolveCode();
  }

  function shorten(value) {
    return value.length > SHORT_LEN ? value.slice(0, SHORT_LEN) + "…" : value;
  }

  function buildFab() {
    var fab = document.createElement("div");
    fab.className = "sim-code-fab";
    fab.innerHTML =
      '<button type="button" class="sim-code-fab-btn" aria-expanded="false" ' +
      'aria-haspopup="dialog" title="Your Sim-Code — click for the full value">' +
      '<span class="sim-code-avatar" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.4"/>' +
      '<path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg></span>' +
      '<span class="sim-code-label">Sim-Code:</span>' +
      '<span class="sim-code-short">…</span>' +
      "</button>" +
      '<div class="sim-code-pop" role="dialog" aria-label="Your Sim-Code" hidden>' +
      "<h4>Your Sim-Code</h4>" +
      '<code class="sim-code-full">…</code>' +
      '<button type="button" class="sim-code-copy">Copy Sim-Code</button>' +
      '<p class="sim-code-hint">Send it as the <code>x-user-code</code> header from a ' +
      "terminal or CI so scripted simulations show up here. Using the browser? " +
      "Nothing to do — the UI already sends it for you.</p>" +
      "</div>";
    document.body.appendChild(fab);
    return fab;
  }

  function wire(fab) {
    var button = fab.querySelector(".sim-code-fab-btn");
    var pop = fab.querySelector(".sim-code-pop");
    var copyButton = fab.querySelector(".sim-code-copy");

    function close() {
      pop.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }

    button.addEventListener("click", function (event) {
      event.stopPropagation();
      if (!code) retryNow();
      var opening = pop.hidden;
      pop.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
    });

    document.addEventListener("click", function (event) {
      if (!pop.hidden && !fab.contains(event.target)) close();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") close();
    });

    copyButton.addEventListener("click", function () {
      if (!code) return;
      navigator.clipboard
        .writeText(code)
        .then(function () {
          copyButton.textContent = "Copied";
          copyButton.classList.add("is-copied");
          setTimeout(function () {
            copyButton.textContent = "Copy Sim-Code";
            copyButton.classList.remove("is-copied");
          }, COPY_FEEDBACK_MS);
        })
        .catch(function (error) {
          console.warn("[Sim-Code] copy failed", error);
        });
    });
  }

  /* There is no "unavailable" state: either a code, or visible progress
     towards one. Three failures in, the pill invites a manual retry. */
  function update() {
    if (!fab) return;

    var short = fab.querySelector(".sim-code-short");
    var full = fab.querySelector(".sim-code-full");
    var button = fab.querySelector(".sim-code-fab-btn");
    var waiting = failedAttempts >= 3 ? "tap to retry" : "issuing…";

    short.textContent = code ? shorten(code) : waiting;
    full.textContent = code ? code : "Issuing your Sim-Code…";
    fab.classList.toggle("is-waiting", !code);
    button.title = code
      ? "Your Sim-Code — click for the full value"
      : "Getting your Sim-Code from the server…";

    /* Every "in your case it will be …" spot in the docs. */
    if (code) {
      var slots = document.querySelectorAll("[data-sim-code]");
      for (var i = 0; i < slots.length; i++) slots[i].textContent = code;
    }
  }

  function start() {
    /* Admin mode has no Sim-Code of its own, so there is nothing to show. */
    if (isAdmin) return;

    fab = buildFab();
    wire(fab);
    update();        /* stored code shows at once, with no flash of progress */
    resolveCode();   /* confirms it, or keeps asking until one is issued */
  }

  /* Shared with the manager UI so both agree on one code. */
  window.SimCode = {
    ready: function () { return resolveCode(); },
    get: function () { return code; },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

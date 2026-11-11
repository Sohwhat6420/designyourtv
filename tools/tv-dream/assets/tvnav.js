/* The TV remote on any website (WebApp.java injects this after each page load). Arrows move a visible focus ring to
   the nearest control in that direction; with none that way, the page (or the panel under the ring) scrolls instead.
   OK clicks. In a text box Left/Right move the caret and Up/Down leave it. Pure DOM, no network, no storage. */
(() => {
  if (window.__tvnav) return;
  window.__tvnav = true;
  const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const st = document.createElement("style");
  st.textContent = ".tvnav-f{outline:3px solid #d97757!important;outline-offset:2px!important;border-radius:6px}";
  (document.head || document.documentElement).appendChild(st);
  let cur = null, pressed = false;
  const box = el => {
    if (!el || !el.isConnected || el.disabled || el.getAttribute("aria-hidden") === "true") return null;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
    const s = getComputedStyle(el);
    return s.visibility === "hidden" || s.display === "none" || +s.opacity === 0 || s.pointerEvents === "none" ? null : r;
  };
  // a resize handle or divider is never somewhere to stop (claude.ai's sidebar edge took the ring, 3 Nov)
  const skip = el => el.matches('[role=separator],[aria-orientation][role=slider]') || /resize/i.test(el.getAttribute("aria-label") || "");
  // an open dialog or menu keeps the ring inside it, as a mouse user's would be
  const scope = () => {
    const open = [...document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],[role=menu],[role=listbox]')].filter(d => box(d));
    return open.length ? open[open.length - 1] : document;
  };
  const editable = el => el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));
  const mark = el => {
    if (cur && cur !== el) cur.classList.remove("tvnav-f");
    cur = el; el.classList.add("tvnav-f");
    // a text box only takes focus on OK: focusing it here would pop the TV keyboard, which then eats the arrows
    const ae = document.activeElement;
    if (editable(el)) { if (ae && ae !== el && ae.blur) ae.blur(); }      // nothing else keeps focus behind the ring
    else try { el.focus({ preventScroll: true }); } catch {}
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const scroller = (el, dy) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) {
        if ((dy > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 2) || (dy < 0 && n.scrollTop > 0)) return n;
      }
    }
    return document.scrollingElement;
  };
  function move(dx, dy) {
    const sc = scope();
    const here = cur && box(cur) && (sc === document || sc.contains(cur)) ? cur : null;
    const a = here ? here.getBoundingClientRect() : { left: innerWidth / 2, right: innerWidth / 2, top: dy > 0 ? 0 : innerHeight, bottom: dy > 0 ? 0 : innerHeight, width: 0, height: 0 };
    const ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2;
    let best = null, bs = Infinity;
    if (!here && sc !== document) {                          // a dialog just opened: start on its first control
      const f = [...sc.querySelectorAll(SEL)].find(el => box(el) && !skip(el));
      if (f) { mark(f); return; }
    }
    for (const el of sc.querySelectorAll(SEL)) {
      if (skip(el)) continue;
      if (el === here || (here && (here.contains(el) || el.contains(here)))) continue;
      const r = box(el); if (!r) continue;
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      // ahead of the current box in that direction (edges, so wide neighbours count)
      const ahead = dx > 0 ? r.left >= a.right - 4 : dx < 0 ? r.right <= a.left + 4 : dy > 0 ? r.top >= a.bottom - 4 : r.bottom <= a.top + 4;
      if (!ahead) continue;
      const main = dx ? Math.abs(cx - ax) : Math.abs(cy - ay);
      const overlap = dx ? Math.max(0, Math.min(r.bottom, a.bottom) - Math.max(r.top, a.top)) : Math.max(0, Math.min(r.right, a.right) - Math.max(r.left, a.left));
      const side = dx ? Math.abs(cy - ay) : Math.abs(cx - ax);
      const score = main + side * (overlap > 0 ? .3 : 2);
      if (score < bs) { bs = score; best = el; }
    }
    if (best) { mark(best); return; }
    if (dy) { const sc = scroller(here || document.elementFromPoint(innerWidth / 2, innerHeight / 2) || document.body, dy); sc && sc.scrollBy({ top: dy * innerHeight * .6, behavior: "smooth" }); }
  }
  addEventListener("keydown", e => {
    pressed = true;
    const k = e.key, t = document.activeElement;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
    if (d) {
      if (editable(t) && d[0]) return;                       // the caret moves inside a text box
      if (t && t.tagName === "SELECT") return;
      if (cur !== t && t && t !== document.body && box(t) && t.matches(SEL)) mark(t);   // the page moved focus itself
      move(d[0], d[1]); e.preventDefault(); e.stopPropagation(); return;
    }
    if (k !== "Enter" || !cur || !box(cur)) return;
    if (editable(cur)) {
      if (t === cur) return;                                   // already typing: Enter submits as usual
      e.preventDefault(); e.stopPropagation(); cur.focus(); cur.click(); return;   // OK opens the keyboard
    }
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) cur.click();
  }, true);
  // Decorative video (claude.ai's sign-in page loops one) kept the TV's decoder busy and the screen awake: a muted,
  // looping or autoplaying video is paused unless the remote started it.
  const calm = () => { for (const v of document.querySelectorAll("video")) if (!v.dataset.tvPlay && (v.muted || v.loop || v.autoplay) && !v.paused) { v.pause(); v.removeAttribute("autoplay"); } };
  addEventListener("play", e => { if (e.target.tagName === "VIDEO" && !e.target.dataset.tvPlay) setTimeout(calm, 0); }, true);
  addEventListener("keydown", e => { if (e.key === "Enter" && cur && cur.tagName === "VIDEO") cur.dataset.tvPlay = "1"; }, true);
  calm(); setInterval(calm, 5000);
  // Back: close an open dialog or menu first (Escape, as the site expects); WebApp.java asks before leaving the page
  window.__tvnavBack = () => {
    const sc = scope();
    if (sc === document) return false;
    const t = document.activeElement && document.activeElement !== document.body ? document.activeElement : sc;
    for (const type of ["keydown", "keyup"]) t.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
    setTimeout(() => { if (cur && !box(cur)) { cur.classList.remove("tvnav-f"); cur = null; move(0, 1); } }, 250);
    return true;
  };
  // a fresh page starts with the ring on its first control, so the remote has somewhere to begin
  // (claude.ai draws itself after the load event, so keep looking for up to 30 s)
  let tries = 0;
  const first = setInterval(() => {
    if ((pressed && cur) || ++tries > 60) return clearInterval(first);   // up to 30 s: a cold claude.ai took ~20 s
    // the first visible text box (claude.ai keeps a hidden textarea ahead of its composer, and draws the composer late)
    const prefer = [...document.querySelectorAll('input[type=email],textarea,[contenteditable=true],.ProseMirror')].find(el => box(el));
    if (prefer) { if (cur !== prefer) mark(prefer); return clearInterval(first); }
    if (!cur && document.querySelector(SEL)) move(0, 1);
  }, 500);
})();

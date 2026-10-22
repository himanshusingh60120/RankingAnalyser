/* nav.js — shared navigation for every page of Ranking X-Ray (index, brief, planner, bulk).
   Load it in each page's <head>:  <script src="/nav.js" defer></script>
   1. Replaces the page's <nav class="ribbon"> with the app menu: the four tools in the order you use
      them, each with a short "use it when", and a "How these tools fit together" guide (open on the
      first visit, then remembered as closed).
   2. AppNav.jumpBar(container, options) puts a sticky "Jump to" bar above long results.
   Nothing else depends on it — if this file fails to load, each page keeps its old ribbon. */
(function () {
  "use strict";

  const TOOLS = [
    { id: "brief", href: "/brief", name: "Content Brief", when: "Before you write",
      re: /^\/brief(?:\.html)?$/,
      guide: "Starting a new report or blog post. Type the keyword to get the writer's skeleton, the competitor analysis and a draft checker." },
    { id: "planner", href: "/planner", name: "Content Planner", when: "Check a finished draft",
      re: /^\/planner(?:\.html)?$/,
      guide: "The draft is written. Paste it to get word and link targets, content gaps, meta tags, FAQs and JSON-LD before you publish." },
    { id: "xray", href: "/", name: "Ranking X-Ray", when: "Diagnose a live page",
      re: /^\/(?:index(?:\.html)?)?$/,
      guide: "The page is live. Enter its URL to see, signal by signal, why the tracked competitors rank above it." },
    { id: "gsc", href: "/bulk", name: "Search Console", when: "Track clicks & indexing",
      re: /^\/bulk(?:\.html)?$/,
      guide: "After publishing. Weekly hreflang reports, metrics for a list of URLs, and crawl-based index status." },
  ];

  const path = location.pathname.replace(/\/+$/, "") || "/";
  const current = TOOLS.find((t) => t.re.test(path)) || null;

  const NAV_CSS = `
.an{padding:14px 0 4px}
.an-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.an-brand{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#4dd0a7;text-decoration:none;margin-right:auto}
.an-help{background:transparent;border:1px solid #1f2a36;color:#8298ad;font:inherit;font-size:12.5px;padding:7px 12px;border-radius:8px;cursor:pointer}
.an-help:hover,.an-help[aria-expanded="true"]{color:#e7edf3;border-color:#4dd0a7}
.an-tools{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.an-tool{display:block;text-decoration:none;color:#e7edf3;background:#0e141b;border:1px solid #1f2a36;border-radius:10px;padding:9px 13px;line-height:1.3}
.an-tool:hover{border-color:#4dd0a7}
.an-n{display:block;font-size:14px;font-weight:600}
.an-w{display:block;font-size:12px;color:#8298ad;margin-top:2px}
.an-tool.on{background:#4dd0a7;border-color:#4dd0a7;color:#04130d}
.an-tool.on .an-w{color:#0d4a37}
.an-guide{background:#121922;border:1px solid #1f2a36;border-radius:12px;padding:14px 16px;margin-top:10px}
.an-guide[hidden]{display:none}
.an-gh{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;font-size:14.5px}
.an-x{background:#4dd0a7;color:#04130d;border:0;border-radius:7px;font:inherit;font-size:12.5px;font-weight:600;padding:6px 12px;cursor:pointer}
.an-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.an-steps li{background:#0e141b;border:1px solid #1f2a36;border-radius:10px;padding:11px 13px;font-size:13px;color:#8298ad}
.an-steps li a{color:#e7edf3;font-weight:600;text-decoration:none}
.an-steps li a:hover{color:#4dd0a7}
.an-steps p{margin:5px 0 0;line-height:1.45}
.an-sn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#1f3a33;color:#4dd0a7;font-size:11px;font-weight:700;margin-right:7px}
.an a:focus-visible,.an button:focus-visible,.jumpbar a:focus-visible{outline:2px solid #4dd0a7;outline-offset:2px}
@media(max-width:820px){.an-tools{display:flex;overflow-x:auto;padding-bottom:4px}.an-tool{flex:none;min-width:160px}.an-steps{grid-template-columns:1fr 1fr}}
@media(max-width:520px){.an-steps{grid-template-columns:1fr}}
.jumpbar{position:sticky;top:0;z-index:25;display:flex;align-items:center;gap:6px;overflow-x:auto;background:rgba(11,15,20,.96);border-bottom:1px solid #1f2a36;padding:9px 2px;margin:18px 0 4px}
.jb-l{flex:none;font-size:12px;color:#5b7186;margin-right:4px}
.jumpbar a{flex:none;font-size:12.5px;color:#8298ad;text-decoration:none;border:1px solid #1f2a36;border-radius:999px;padding:5px 11px;white-space:nowrap}
.jumpbar a:hover{color:#e7edf3;border-color:#4dd0a7}
.jumpbar a.on{color:#04130d;background:#4dd0a7;border-color:#4dd0a7}
.jumpbar a.jb-sub{border-style:dashed}
.jumpbar a.jb-form{margin-left:auto;color:#4dd0a7}
@media print{.an,.jumpbar{display:none !important}}
`;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const smooth = () => (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
  const cssId = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));

  function injectCss() {
    if (document.getElementById("an-css")) return;
    const st = document.createElement("style");
    st.id = "an-css";
    st.textContent = NAV_CSS;
    document.head.appendChild(st);
  }

  /* ---------- 1. the app menu ---------- */
  function build() {
    injectCss();
    const old = document.querySelector("nav.ribbon");
    if (!old || document.querySelector("nav.an")) return;
    let seen = false;
    try { seen = localStorage.getItem("appnav.guide") === "seen"; } catch { /* storage off */ }
    const nav = document.createElement("nav");
    nav.className = "an";
    nav.setAttribute("aria-label", "Ranking X-Ray tools");
    nav.innerHTML =
      `<div class="an-top"><a class="an-brand" href="/">Ranking X-Ray</a>` +
      `<button type="button" class="an-help" aria-expanded="${!seen}" aria-controls="anGuide">How these tools fit together</button></div>` +
      `<div class="an-tools">${TOOLS.map((t) => {
        const on = current && current.id === t.id;
        return `<a class="an-tool${on ? " on" : ""}" href="${t.href}"${on ? ' aria-current="page"' : ""}><span class="an-n">${esc(t.name)}</span><span class="an-w">${esc(t.when)}</span></a>`;
      }).join("")}</div>` +
      `<div class="an-guide" id="anGuide"${seen ? " hidden" : ""}>` +
      `<div class="an-gh"><b>How the four tools fit together</b><button type="button" class="an-x">Got it</button></div>` +
      `<ol class="an-steps">${TOOLS.map((t, i) => `<li><span class="an-sn">${i + 1}</span><a href="${t.href}">${esc(t.name)}</a><p>${esc(t.guide)}</p></li>`).join("")}</ol></div>`;
    old.replaceWith(nav);
    const guide = nav.querySelector(".an-guide");
    const btn = nav.querySelector(".an-help");
    const setGuide = (open) => {
      guide.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (!open) { try { localStorage.setItem("appnav.guide", "seen"); } catch { /* storage off */ } }
    };
    btn.addEventListener("click", () => setGuide(guide.hidden));
    nav.querySelector(".an-x").addEventListener("click", () => setGuide(false));
  }

  /* ---------- 2. "Jump to" bar for long results ---------- */
  // "Search Console — your page (90d)" → "Search Console"; short leads like "AI — what to add" keep their subtitle.
  function shortLabel(text) {
    let t = String(text || "").replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
    const parts = t.split(/\s[—–]\s/);
    if (parts.length > 1) t = parts[0].length > 4 ? parts[0] : `${parts[0]} — ${parts[1]}`;
    return t.length > 34 ? `${t.slice(0, 32).trim()}…` : t;
  }

  const observers = new WeakMap();
  // options: selector (default "h3.section"), skip (headings inside these are ignored, default ".comp"),
  //          prefix (for generated ids), extra [{ el, label }] (sub-items such as competitor cards),
  //          formId + formLabel (a button back to the form).
  function jumpBar(container, opts = {}) {
    if (!container) return;
    injectCss();
    if (observers.has(container)) { observers.get(container).disconnect(); observers.delete(container); }
    container.querySelectorAll(":scope > .jumpbar").forEach((n) => n.remove());
    const prefix = opts.prefix || "sec";
    const skip = opts.skip || ".comp";
    const items = [...container.querySelectorAll(opts.selector || "h3.section")]
      .filter((h) => !h.closest(skip))
      .map((el) => ({ el, label: shortLabel(el.textContent), sub: false }));
    (opts.extra || []).forEach((x) => { if (x && x.el) items.push({ el: x.el, label: shortLabel(x.label), sub: true }); });
    if (items.length < 3) return;
    items.forEach((it, i) => { if (!it.el.id) it.el.id = `${prefix}-${i}`; it.el.style.scrollMarginTop = "64px"; });

    const bar = document.createElement("nav");
    bar.className = "jumpbar";
    bar.setAttribute("aria-label", "Jump to a section");
    bar.innerHTML = `<span class="jb-l">Jump to</span>` +
      items.map((it) => `<a href="#${esc(it.el.id)}" data-jb="${esc(it.el.id)}"${it.sub ? ' class="jb-sub"' : ""}>${esc(it.label)}</a>`).join("") +
      (opts.formId ? `<a href="#" class="jb-form" data-jb="__form">${esc(opts.formLabel || "Back to the form")}</a>` : "");
    container.prepend(bar);
    bar.addEventListener("click", (e) => {
      const a = e.target.closest("[data-jb]");
      if (!a) return;
      e.preventDefault();
      const target = a.dataset.jb === "__form" ? document.getElementById(opts.formId) : document.getElementById(a.dataset.jb);
      if (target) target.scrollIntoView({ behavior: smooth(), block: "start" });
    });

    if ("IntersectionObserver" in window) {
      const obs = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          bar.querySelectorAll("a.on").forEach((a) => a.classList.remove("on"));
          const a = bar.querySelector(`a[data-jb="${cssId(en.target.id)}"]`);
          if (a) a.classList.add("on");
        });
      }, { rootMargin: "-70px 0px -70% 0px" });
      items.forEach((it) => obs.observe(it.el));
      observers.set(container, obs);
    }
  }

  window.AppNav = { jumpBar, tools: TOOLS };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();

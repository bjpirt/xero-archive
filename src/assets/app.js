/* Xero Archive — static browser. Vanilla JS, no dependencies. */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var manifest = null;
  var cache = {}; // entityName -> records[]
  var PAGE_SIZES = [50, 100, 250, 1000];
  var DEFAULT_PAGE_SIZE = 100;

  // --- helpers ---------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function getPath(obj, p) {
    return p.split(".").reduce(function (o, k) {
      return o == null ? undefined : o[k];
    }, obj);
  }
  // Dates are archived as ISO 8601; the /Date(…)/ branch stays for older archives.
  function parseDate(v) {
    if (typeof v !== "string" || !v) return null;
    var m = v.match(/\/Date\((-?\d+)/);
    var d = m ? new Date(Number(m[1])) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  // Always format in UTC: Xero's date-only fields are midnight UTC, so rendering in
  // a negative-offset local timezone would show the previous day.
  function fmt(opts) {
    var f = new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: "UTC" }, opts));
    return function (v) {
      var d = parseDate(v);
      return d ? f.format(d) : v || "";
    };
  }
  var fmtDate = fmt({ day: "numeric", month: "short", year: "numeric" }); // 28 Jan 2020
  var fmtDateLong = fmt({ weekday: "short", day: "numeric", month: "long", year: "numeric" });
  var fmtDateTime = fmt({
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }); // 28 Jan 2020, 14:32

  /** True for keys Xero uses for dates, so the detail view can format them. */
  function isDateKey(k) {
    return /Date$/.test(k) || /DateUTC$/.test(k) || /^Date/.test(k) || k === "FullyPaidOnDate";
  }

  var moneyFmts = {};
  function fmtMoney(v, currency) {
    var n = Number(v);
    if (!isFinite(n)) return "";
    var key = currency || "-";
    if (!moneyFmts[key]) {
      try {
        moneyFmts[key] = new Intl.NumberFormat("en-GB", {
          style: currency ? "currency" : "decimal",
          currency: currency || undefined,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      } catch (e) {
        moneyFmts[key] = new Intl.NumberFormat("en-GB", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      }
    }
    return moneyFmts[key].format(n);
  }

  /** Xero's wire codes, spelled out. */
  var LABELS = {
    ACCREC: "Sales invoice", ACCPAY: "Bill",
    ACCRECCREDIT: "Sales credit note", ACCPAYCREDIT: "Bill credit note",
    ACCRECPAYMENT: "Sales payment", ACCPAYPAYMENT: "Bill payment",
    SPEND: "Spend", RECEIVE: "Receive",
    "SPEND-OVERPAYMENT": "Spend overpayment", "RECEIVE-OVERPAYMENT": "Receive overpayment",
    "SPEND-PREPAYMENT": "Spend prepayment", "RECEIVE-PREPAYMENT": "Receive prepayment",
    "SPEND-TRANSFER": "Transfer out", "RECEIVE-TRANSFER": "Transfer in",
    ARCREDIT: "Sales credit", APCREDIT: "Bill credit",
    AROVERPAYMENT: "Sales overpayment", APOVERPAYMENT: "Bill overpayment",
    ARPREPAYMENT: "Sales prepayment", APPREPAYMENT: "Bill prepayment",
    CASHREC: "Cash received", CASHPAID: "Cash paid",
    TRANSFER: "Transfer", MANJOURNAL: "Manual journal",
    INTEGRATEDPAYROLLPE: "Payroll", INTEGRATEDPAYROLLPT: "Payroll tax",
  };
  /** Semantic grouping so status badges can be coloured rather than all alike. */
  var BADGE_TONE = {
    PAID: "ok", AUTHORISED: "ok", ACTIVE: "ok", ACCEPTED: "ok", RECONCILED: "ok",
    DRAFT: "muted", SUBMITTED: "warn", AWAITING_APPROVAL: "warn", SENT: "warn",
    VOIDED: "bad", DELETED: "bad", ARCHIVED: "bad", DECLINED: "bad", GST_ERROR: "bad",
  };
  function label(v) {
    var s = String(v);
    return LABELS[s] || s.replace(/_/g, " ");
  }

  /** Xero field names as prose: "AmountDue" → "Amount due". */
  var KEY_LABELS = {
    UpdatedDateUTC: "Last updated", CurrencyCode: "Currency", CurrencyRate: "Exchange rate",
    LineAmountTypes: "Tax treatment", SubTotal: "Subtotal", TotalTax: "Tax",
    ContactStatus: "Status", AccountNumber: "Account number", DefaultCurrency: "Default currency",
    FullyPaidOnDate: "Fully paid on", ExpectedPaymentDate: "Expected payment",
    PlannedPaymentDate: "Planned payment", BrandingThemeID: "Branding theme",
    SourceType: "Source", SourceID: "Source document", Url: "Xero link",
  };
  function humanKey(k) {
    if (KEY_LABELS[k]) return KEY_LABELS[k];
    return k
      .replace(/UTC$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/^./, function (c) {
        return c.toUpperCase();
      });
  }
  function badge(v) {
    var tone = BADGE_TONE[String(v)] || "";
    return '<span class="badge' + (tone ? " " + tone : "") + '">' + esc(label(v)) + "</span>";
  }

  function fmtCell(val, col, rec) {
    if (val == null || val === "") return "";
    var type = col && col.type;
    var html;
    if (type === "date") html = esc(fmtDate(val));
    else if (type === "money") html = '<span class="num">' + esc(fmtMoney(val, rec && rec.CurrencyCode)) + "</span>";
    else if (type === "badge") html = badge(val);
    else html = esc(val);
    var href = col && col.link ? linkHref(col.link, rec) : null;
    return href ? '<a href="' + esc(href) + '">' + html + "</a>" : html;
  }

  /** Resolves a column's `link` to a hash, or null if it can't be followed. */
  function linkHref(link, rec) {
    if (!link || !entityExists(link.entity)) return null;
    var val = getPath(rec, link.idKey);
    if (val == null || val === "") return null;
    return link.by
      ? hashFor(["e", link.entity], { link: link.by + ":" + val })
      : hashFor(["e", link.entity, String(val)], {});
  }

  function entityExists(name) {
    return (manifest.entities || []).some(function (e) {
      return e.name === name;
    });
  }

  function entityLabel(name) {
    var e = (manifest.entities || []).find(function (x) {
      return x.name === name;
    });
    return e ? e.view.label : name;
  }

  /** Splits "#/e/Invoices?q=acme&p=3" into path parts and a params object. */
  function parseHash() {
    var hash = location.hash || "#/";
    var qi = hash.indexOf("?");
    var params = {};
    if (qi !== -1) {
      hash
        .slice(qi + 1)
        .split("&")
        .forEach(function (kv) {
          if (!kv) return;
          var i = kv.indexOf("=");
          var k = i === -1 ? kv : kv.slice(0, i);
          var v = i === -1 ? "" : kv.slice(i + 1);
          params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
        });
      hash = hash.slice(0, qi);
    }
    return {
      parts: hash.replace(/^#\//, "").split("/").filter(Boolean).map(decodeURIComponent),
      params: params,
    };
  }

  /** Rebuilds a hash from parts + params, dropping empty params so URLs stay short. */
  function hashFor(parts, params) {
    var qs = Object.keys(params)
      .filter(function (k) {
        return params[k] !== "" && params[k] != null;
      })
      .map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
      })
      .join("&");
    return "#/" + parts.map(encodeURIComponent).join("/") + (qs ? "?" + qs : "");
  }

  function withParams(params, changes) {
    var out = {};
    Object.keys(params).forEach(function (k) {
      out[k] = params[k];
    });
    Object.keys(changes).forEach(function (k) {
      out[k] = changes[k];
    });
    return out;
  }

  function loadEntity(name) {
    if (cache[name]) return Promise.resolve(cache[name]);
    return fetch("./data/" + encodeURIComponent(name) + ".json")
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        cache[name] = d;
        return d;
      });
  }

  // --- layout ----------------------------------------------------------------
  function sidebar(active) {
    var org = manifest.org || {};
    var groups = { transaction: [], ledger: [], master: [] };
    manifest.entities.forEach(function (e) {
      (groups[e.group] || groups.master).push(e);
    });
    function navItems(list) {
      return list
        .map(function (e) {
          var cls = active === "#/e/" + e.name ? "active" : "";
          return (
            '<a class="' +
            cls +
            '" href="#/e/' +
            e.name +
            '">' +
            esc(e.view.label) +
            '<span class="count">' +
            e.count +
            "</span></a>"
          );
        })
        .join("");
    }
    var reportKinds = Object.keys(manifest.reports || {});
    var reportsNav = reportKinds.length
      ? '<div class="nav-group">Reports</div><div class="nav"><a class="' +
        (active === "#/reports" ? "active" : "") +
        '" href="#/reports">Financial statements</a></div>'
      : "";
    return (
      '<aside class="sidebar">' +
      '<h1><a href="#/" style="color:inherit">' +
      esc(org.Name || "Xero Archive") +
      "</a></h1>" +
      '<div class="org-sub">' +
      [org.OrganisationType, org.CountryCode, org.BaseCurrency].filter(Boolean).map(esc).join(" · ") +
      "</div>" +
      '<div class="nav-group">Transactions</div><div class="nav">' +
      navItems(groups.transaction) +
      "</div>" +
      (groups.ledger.length ? '<div class="nav-group">Ledger</div><div class="nav">' + navItems(groups.ledger) + "</div>" : "") +
      '<div class="nav-group">Master data</div><div class="nav">' +
      navItems(groups.master) +
      "</div>" +
      reportsNav +
      "</aside>"
    );
  }

  function render(active, mainHtml) {
    app.className = "";
    app.innerHTML = '<div class="layout">' + sidebar(active) + '<main class="main">' + mainHtml + "</main></div>";
  }

  // --- views -----------------------------------------------------------------
  function viewHome() {
    var org = manifest.org || {};
    var cards = manifest.entities
      .map(function (e) {
        return (
          '<a class="card" href="#/e/' +
          e.name +
          '"><div class="num">' +
          e.count +
          '</div><div class="lbl">' +
          esc(e.view.label) +
          "</div></a>"
        );
      })
      .join("");
    var meta =
      '<div class="detail-grid" style="margin-bottom:1.5rem">' +
      Object.keys(org)
        .filter(function (k) {
          return org[k] != null && org[k] !== "";
        })
        .map(function (k) {
          return "<dt>" + esc(humanKey(k)) + "</dt><dd>" + esc(label(org[k])) + "</dd>";
        })
        .join("") +
      "</div>";
    render(
      "#/",
      "<h2>Overview</h2>" +
        meta +
        '<h3 style="margin:0 0 .75rem">Archived records</h3><div class="cards">' +
        cards +
        "</div>" +
        '<p class="hint" style="margin-top:1.5rem">Archive generated ' +
        esc(fmtDateTime(manifest.generatedAt)) +
        "</p>"
    );
  }

  /** Matches a path against a value, allowing one `[]` array hop. */
  function pathMatches(rec, path, value) {
    var hop = path.indexOf("[]");
    if (hop === -1) return String(getPath(rec, path)) === String(value);
    var arr = getPath(rec, path.slice(0, hop));
    var rest = path.slice(hop + 3); // past "[]."
    return (
      Array.isArray(arr) &&
      arr.some(function (it) {
        return String(getPath(it, rest)) === String(value);
      })
    );
  }

  /**
   * Text a search should look at: the columns on show plus the free-text fields
   * people actually search by. Deliberately not JSON.stringify(record) — that
   * matched field names and internal GUIDs, so "paid" hit every record with an
   * AmountPaid key. Cached per record.
   */
  var EXTRA_SEARCH = ["Reference", "Narration", "Description", "EmailAddress", "Name", "Code"];
  var searchCache = new WeakMap(); // off-record, so it can't leak into the Raw JSON view
  function searchText(rec, cols) {
    var hit = searchCache.get(rec);
    if (hit != null) return hit;
    var bits = cols.map(function (c) {
      return getPath(rec, c.key);
    });
    EXTRA_SEARCH.forEach(function (k) {
      if (rec[k] != null) bits.push(rec[k]);
    });
    (rec.LineItems || []).forEach(function (li) {
      bits.push(li.Description);
    });
    hit = bits
      .filter(function (v) {
        return v != null && v !== "";
      })
      .join(" ")
      .toLowerCase();
    searchCache.set(rec, hit);
    return hit;
  }

  function pagerHtml(name, params, page, pages, start, shownLen, total, size) {
    function btn(p, text, disabled) {
      if (disabled) return '<span class="pg disabled">' + text + "</span>";
      var href = hashFor(["e", name], withParams(params, { p: p === 1 ? "" : String(p) }));
      return '<a class="pg" href="' + esc(href) + '">' + text + "</a>";
    }
    var sizes = PAGE_SIZES.map(function (s) {
      return '<option value="' + s + '"' + (s === size ? " selected" : "") + ">" + s + "</option>";
    }).join("");
    return (
      '<div class="pager">' +
      '<span class="hint">' +
      (total ? start + 1 + "–" + (start + shownLen) + " of " + total : "0") +
      "</span>" +
      (pages > 1
        ? '<span class="pg-group">' +
          btn(1, "« First", page === 1) +
          btn(page - 1, "‹ Prev", page === 1) +
          '<span class="pg-cur">Page ' + page + " of " + pages + "</span>" +
          btn(page + 1, "Next ›", page === pages) +
          btn(pages, "Last »", page === pages) +
          "</span>"
        : "") +
      '<label class="pg-size">Rows <select id="pagesize">' + sizes + "</select></label>" +
      "</div>"
    );
  }

  function viewList(name, params) {
    var meta = manifest.entities.find(function (e) {
      return e.name === name;
    });
    if (!meta) return viewHome();
    var q = params.q || "";
    loadEntity(name).then(function (records) {
      var cols = meta.view.columns;
      var filtered = records;
      var chip = "";

      // ?link=Path:value — the reverse of a cross-entity link.
      if (params.link) {
        var ci = params.link.indexOf(":");
        var lp = params.link.slice(0, ci);
        var lv = params.link.slice(ci + 1);
        filtered = filtered.filter(function (r) {
          return pathMatches(r, lp, lv);
        });
        chip =
          '<div class="chip">Filtered: <b>' +
          esc(lp.replace(/\[\]\./g, " › ")) +
          "</b> = <b>" +
          esc(lv) +
          '</b> <a href="' +
          esc(hashFor(["e", name], withParams(params, { link: "", p: "" }))) +
          '" title="Clear filter">✕</a></div>';
      }

      if (q) {
        var ql = q.toLowerCase();
        filtered = filtered.filter(function (r) {
          return searchText(r, cols).indexOf(ql) !== -1;
        });
      }

      var size = PAGE_SIZES.indexOf(Number(params.size)) !== -1 ? Number(params.size) : DEFAULT_PAGE_SIZE;
      var pages = Math.max(1, Math.ceil(filtered.length / size));
      var page = Math.min(Math.max(1, parseInt(params.p, 10) || 1), pages);
      var start = (page - 1) * size;
      var shown = filtered.slice(start, start + size);

      var head = cols
        .map(function (c) {
          return "<th" + (c.type === "money" ? ' class="num"' : "") + ">" + esc(c.label) + "</th>";
        })
        .join("");
      var body = shown
        .map(function (r) {
          var tds = cols
            .map(function (c) {
              return "<td" + (c.type === "money" ? ' class="num"' : "") + ">" + fmtCell(getPath(r, c.key), c, r) + "</td>";
            })
            .join("");
          var att = r._attachments && r._attachments.length ? "📎" : "";
          return (
            '<tr data-id="' + esc(r[meta.view.idField]) + '">' + tds + '<td class="att">' + att + "</td></tr>"
          );
        })
        .join("");

      var pager = pagerHtml(name, params, page, pages, start, shown.length, filtered.length, size);
      render(
        "#/e/" + name,
        '<div class="crumbs"><a href="#/">Home</a> / ' +
          esc(meta.view.label) +
          "</div><h2>" +
          esc(meta.view.label) +
          "</h2>" +
          chip +
          '<div class="toolbar"><input type="search" id="q" placeholder="Search ' +
          esc(meta.view.label) +
          '…" value="' +
          esc(q) +
          '"></div>' +
          pager +
          '<div class="table-wrap"><table><thead><tr>' +
          head +
          '<th class="att"></th></tr></thead><tbody>' +
          body +
          "</tbody></table></div>" +
          pager
      );

      var input = document.getElementById("q");
      var t;
      input.addEventListener("input", function () {
        clearTimeout(t);
        t = setTimeout(function () {
          // A new search invalidates the page number.
          location.hash = hashFor(["e", name], withParams(params, { q: input.value, p: "" }));
        }, 250);
      });
      Array.prototype.forEach.call(document.querySelectorAll("#pagesize"), function (sel) {
        sel.addEventListener("change", function () {
          location.hash = hashFor(["e", name], withParams(params, { size: sel.value, p: "" }));
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll("tbody tr"), function (tr) {
        tr.addEventListener("click", function (ev) {
          if (ev.target.closest("a")) return; // let cell links win
          location.hash = hashFor(["e", name, tr.getAttribute("data-id")], {});
        });
      });
    });
  }

  /**
   * Renders a child array (line items, journal lines, related documents) using
   * column definitions from the manifest, so links work the same as in list views.
   * Columns with no value anywhere in the rows are dropped.
   */
  function childTable(rows, cols, parent, rowHref) {
    var present = cols.filter(function (c) {
      return rows.some(function (r) {
        var v = getPath(r, c.key);
        return v != null && v !== "";
      });
    });
    if (present.length === 0) return "";
    var head = present
      .map(function (c) {
        return "<th" + (c.type === "money" ? ' class="num"' : "") + ">" + esc(c.label) + "</th>";
      })
      .join("");
    var body = rows
      .map(function (r) {
        // Currency lives on the parent document, not the line.
        var ctx = parent && parent.CurrencyCode && !r.CurrencyCode ? { CurrencyCode: parent.CurrencyCode } : null;
        var tds = present
          .map(function (c) {
            var val = getPath(r, c.key);
            var cell = fmtCell(val, c, ctx ? Object.assign({}, r, ctx) : r);
            return "<td" + (c.type === "money" ? ' class="num"' : "") + ">" + cell + "</td>";
          })
          .join("");
        var href = rowHref ? rowHref(r) : null;
        return href ? '<tr class="clickable" data-href="' + esc(href) + '">' + tds + "</tr>" : "<tr>" + tds + "</tr>";
      })
      .join("");
    return '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  function historyTable(hist) {
    var body = hist
      .map(function (h) {
        return (
          "<tr><td>" +
          esc(fmtDateTime(h.DateUTCString || h.DateUTC)) +
          "</td><td>" +
          esc(h.User) +
          "</td><td>" +
          esc(h.Changes) +
          "</td><td>" +
          esc(h.Details) +
          "</td></tr>"
        );
      })
      .join("");
    return (
      '<div class="table-wrap"><table><thead><tr><th>Date</th><th>User</th><th>Change</th><th>Details</th></tr></thead><tbody>' +
      body +
      "</tbody></table></div>"
    );
  }

  function viewDetail(name, id) {
    var meta = manifest.entities.find(function (e) {
      return e.name === name;
    });
    if (!meta) return viewHome();
    loadEntity(name).then(function (records) {
      var rec = records.find(function (r) {
        return String(r[meta.view.idField]) === String(id);
      });
      if (!rec) {
        render("#/e/" + name, "<p>Record not found.</p>");
        return;
      }
      var title = meta.view.titleField ? rec[meta.view.titleField] : rec[meta.view.idField];

      // Fields the view already highlights, or that are noise on a detail page.
      var HIDE = { HasErrors: 1, HasValidationErrors: 1, HasAttachments: 1, IsDiscounted: 1, ValidationErrors: 1 };
      var rows = [];
      Object.keys(rec).forEach(function (k) {
        if (k.charAt(0) === "_" || HIDE[k]) return;
        // Xero sends DateString alongside Date; now dates are stored as ISO the
        // companion adds nothing.
        if (/String$/.test(k) && rec[k.replace(/String$/, "")] != null) return;
        var v = rec[k];
        if (v == null || v === "") return;
        if (Array.isArray(v)) return; // rendered as its own block below
        if (typeof v === "object") {
          if (!v.Name) return;
          // Nested documents (Contact, BankAccount, Account) become links.
          var nested = { entity: k + "s", idKey: k + "." + k + "ID" };
          if (k === "BankAccount" || k === "FromBankAccount" || k === "ToBankAccount" || k === "Account") {
            nested = { entity: "Accounts", idKey: k + ".AccountID" };
          }
          var href = linkHref(nested, rec);
          rows.push(
            "<dt>" + esc(humanKey(k)) + "</dt><dd>" +
              (href ? '<a href="' + esc(href) + '">' + esc(v.Name) + "</a>" : esc(v.Name)) +
              "</dd>"
          );
          return;
        }
        var disp;
        if (typeof v === "boolean") disp = v ? "Yes" : "No";
        else if (isDateKey(k)) disp = /DateUTC$/.test(k) ? fmtDateTime(v) : fmtDateLong(v);
        else if (/^(Total|SubTotal|Amount|.*Amount|.*Total)$/.test(k) && isFinite(Number(v)))
          disp = fmtMoney(v, rec.CurrencyCode);
        else disp = /^(Type|Status|PaymentType|LineAmountTypes|SourceType)$/.test(k) ? label(v) : v;
        rows.push("<dt>" + esc(humanKey(k)) + "</dt><dd>" + esc(disp) + "</dd>");
      });

      var blocks = "";
      if (Array.isArray(rec.LineItems) && rec.LineItems.length)
        blocks +=
          '<section class="block"><h3>Line items</h3>' +
          childTable(rec.LineItems, manifest.lineItemColumns || [], rec) +
          "</section>";
      if (Array.isArray(rec.JournalLines) && rec.JournalLines.length)
        blocks +=
          '<section class="block"><h3>Journal lines</h3>' +
          childTable(rec.JournalLines, manifest.journalLineColumns || [], rec) +
          "</section>";

      // Related documents declared in the view (payments, credit notes, …).
      (meta.view.related || []).forEach(function (rel) {
        var rows2 = rec[rel.arrayKey];
        if (!Array.isArray(rows2) || rows2.length === 0) return;
        var linkable = entityExists(rel.entity);
        blocks +=
          '<section class="block"><h3>' +
          esc(rel.label) +
          (linkable ? "" : ' <span class="hint">(not archived)</span>') +
          "</h3>" +
          childTable(rows2, rel.columns, rec, function (r) {
            return linkable && r[rel.idKey] ? hashFor(["e", rel.entity, String(r[rel.idKey])], {}) : null;
          }) +
          "</section>";
      });

      // Reverse links: other entities that point at this record.
      var backs = (meta.view.backlinks || []).filter(function (b) {
        return entityExists(b.entity);
      });
      if (backs.length) {
        blocks +=
          '<section class="block"><h3>Related records</h3><div class="backlinks">' +
          backs
            .map(function (b, i) {
              var val = rec[b.valueKey || meta.view.idField];
              var href = hashFor(["e", b.entity], { link: b.path + ":" + val });
              return (
                '<a class="backlink" id="bl' + i + '" href="' + esc(href) + '">' +
                esc(entityLabel(b.entity)) +
                ' <span class="count">…</span></a>'
              );
            })
            .join("") +
          "</div></section>";
      }

      if (Array.isArray(rec._attachments) && rec._attachments.length) {
        blocks +=
          '<section class="block attach"><h3>Attachments</h3>' +
          rec._attachments
            .map(function (a) {
              return '<a href="' + esc(a.href) + '" target="_blank" rel="noopener">📎 ' + esc(a.name) + "</a>";
            })
            .join("") +
          "</section>";
      }
      if (Array.isArray(rec._history) && rec._history.length)
        blocks += '<section class="block"><h3>History &amp; notes</h3>' + historyTable(rec._history) + "</section>";

      render(
        "#/e/" + name,
        '<div class="crumbs"><a href="#/">Home</a> / <a href="#/e/' +
          name +
          '">' +
          esc(meta.view.label) +
          "</a> / " +
          esc(title) +
          "</div><h2>" +
          esc(title) +
          '</h2><dl class="detail-grid">' +
          rows.join("") +
          "</dl>" +
          blocks +
          '<details class="raw"><summary>Raw JSON</summary><pre>' +
          esc(JSON.stringify(rec, null, 2)) +
          "</pre></details>"
      );

      // Rows in related-document tables navigate to that document.
      Array.prototype.forEach.call(document.querySelectorAll("tr.clickable"), function (tr) {
        tr.addEventListener("click", function (ev) {
          if (ev.target.closest("a")) return;
          location.hash = tr.getAttribute("data-href");
        });
      });

      // Fill in reverse-link counts once each target entity has loaded.
      backs.forEach(function (b, i) {
        var el = document.getElementById("bl" + i);
        if (!el) return;
        var val = rec[b.valueKey || meta.view.idField];
        loadEntity(b.entity)
          .then(function (rows2) {
            var n = rows2.filter(function (r) {
              return pathMatches(r, b.path, val);
            }).length;
            var span = el.querySelector(".count");
            if (!span) return;
            span.textContent = n;
            if (n === 0) el.className += " empty";
          })
          .catch(function () {
            var span = el.querySelector(".count");
            if (span) span.textContent = "?";
          });
      });
    });
  }

  // --- reports ---------------------------------------------------------------
  function viewReports() {
    var kinds = manifest.reports || {};
    var html = '<div class="crumbs"><a href="#/">Home</a> / Reports</div><h2>Financial statements</h2>';
    Object.keys(kinds).forEach(function (kind) {
      html +=
        "<h3>" +
        esc(kind) +
        '</h3><div class="cards" style="margin-bottom:1rem">' +
        kinds[kind]
          .map(function (r) {
            return (
              '<a class="card" href="#/report/' +
              encodeURIComponent(kind) +
              "/" +
              encodeURIComponent(r.file) +
              '"><div class="num" style="font-size:1.1rem">' +
              esc(r.label) +
              "</div></a>"
            );
          })
          .join("") +
        "</div>";
    });
    render("#/reports", html);
  }

  function renderReportRows(rows) {
    if (!Array.isArray(rows)) return "";
    var out = "";
    rows.forEach(function (row) {
      if (row.RowType === "Header") {
        out +=
          "<thead><tr>" +
          (row.Cells || [])
            .map(function (c, i) {
              return "<th" + (i > 0 ? ' class="num"' : "") + ">" + esc(c.Value) + "</th>";
            })
            .join("") +
          "</tr></thead>";
      } else if (row.RowType === "Section") {
        if (row.Title) out += '<tbody><tr><td class="report-section-title" colspan="20">' + esc(row.Title) + "</td></tr></tbody>";
        out += "<tbody>" + innerRows(row.Rows) + "</tbody>";
      } else {
        out += "<tbody>" + innerRows([row]) + "</tbody>";
      }
    });
    return out;
  }
  function innerRows(rows) {
    return (rows || [])
      .map(function (row) {
        var bold = row.RowType === "SummaryRow";
        return (
          "<tr" + (bold ? ' style="font-weight:700"' : "") + ">" +
          (row.Cells || [])
            .map(function (c, i) {
              return "<td" + (i > 0 ? ' class="num"' : "") + ">" + esc(c.Value) + "</td>";
            })
            .join("") +
          "</tr>"
        );
      })
      .join("");
  }

  function viewReport(kind, file) {
    fetch(manifest.base + "/reports/" + encodeURIComponent(kind) + "/" + encodeURIComponent(file))
      .then(function (r) {
        return r.json();
      })
      .then(function (rep) {
        var titles = (rep.ReportTitles || []).map(esc).join(" — ");
        render(
          "#/reports",
          '<div class="crumbs"><a href="#/">Home</a> / <a href="#/reports">Reports</a> / ' +
            esc(kind) +
            '</div><div class="report-title">' +
            titles +
            "</div><h2>" +
            esc(rep.ReportName || kind) +
            '</h2><div class="table-wrap"><table>' +
            renderReportRows(rep.Rows) +
            "</table></div>"
        );
      })
      .catch(function () {
        render("#/reports", "<p>Could not load report.</p>");
      });
  }

  // --- router ----------------------------------------------------------------
  function route() {
    var r = parseHash();
    var parts = r.parts;
    if (parts.length === 0) return viewHome();
    if (parts[0] === "reports") return viewReports();
    if (parts[0] === "report" && parts.length >= 3) return viewReport(parts[1], parts[2]);
    if (parts[0] === "e" && parts.length === 2) return viewList(parts[1], r.params);
    if (parts[0] === "e" && parts.length >= 3) return viewDetail(parts[1], parts.slice(2).join("/"));
    return viewHome();
  }

  fetch("./data/manifest.json")
    .then(function (r) {
      if (!r.ok) throw new Error("no manifest");
      return r.json();
    })
    .then(function (m) {
      manifest = m;
      window.addEventListener("hashchange", route);
      route();
    })
    .catch(function () {
      app.innerHTML =
        '<p class="loading">Could not load <code>data/manifest.json</code>.<br>Serve the archive over HTTP with <code>npm run serve</code> — opening the file directly (file://) will not work.</p>';
    });
})();

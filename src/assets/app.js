/* Xero Archive — static browser. Vanilla JS, no dependencies. */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var manifest = null;
  var cache = {}; // entityName -> records[]
  var MAX_ROWS = 500;

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
  function parseDate(v) {
    if (typeof v !== "string" || !v) return null;
    var m = v.match(/\/Date\((-?\d+)/);
    var d = m ? new Date(Number(m[1])) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(v) {
    var d = parseDate(v);
    return d ? d.toISOString().slice(0, 10) : v || "";
  }
  function fmtDateTime(v) {
    var d = parseDate(v);
    return d ? d.toISOString().slice(0, 19).replace("T", " ") : v || "";
  }
  function fmtMoney(v) {
    var n = Number(v);
    return isFinite(n) ? n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
  }
  function fmtCell(val, type, rec) {
    if (val == null || val === "") return "";
    if (type === "date") return esc(fmtDate(val));
    if (type === "money") {
      var c = rec && rec.CurrencyCode ? esc(rec.CurrencyCode) + " " : "";
      return '<span class="num">' + c + esc(fmtMoney(val)) + "</span>";
    }
    if (type === "badge") return '<span class="badge">' + esc(val) + "</span>";
    return esc(val);
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
          return "<dt>" + esc(k) + "</dt><dd>" + esc(org[k]) + "</dd>";
        })
        .join("") +
      "</dt></div>";
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

  function viewList(name, q) {
    var meta = manifest.entities.find(function (e) {
      return e.name === name;
    });
    if (!meta) return viewHome();
    loadEntity(name).then(function (records) {
      var cols = meta.view.columns;
      var filtered = records;
      if (q) {
        var ql = q.toLowerCase();
        filtered = records.filter(function (r) {
          return JSON.stringify(r).toLowerCase().indexOf(ql) !== -1;
        });
      }
      var shown = filtered.slice(0, MAX_ROWS);
      var head = cols
        .map(function (c) {
          return "<th>" + esc(c.label) + "</th>";
        })
        .join("");
      var body = shown
        .map(function (r) {
          var id = r[meta.view.idField];
          var tds = cols
            .map(function (c) {
              return "<td>" + fmtCell(getPath(r, c.key), c.type, r) + "</td>";
            })
            .join("");
          return '<tr data-id="' + esc(id) + '">' + tds + "</tr>";
        })
        .join("");
      var note =
        filtered.length > MAX_ROWS
          ? '<span class="hint">Showing first ' + MAX_ROWS + " of " + filtered.length + " — refine your search.</span>"
          : '<span class="hint">' + filtered.length + " record(s)</span>";
      render(
        "#/e/" + name,
        '<div class="crumbs"><a href="#/">Home</a> / ' +
          esc(meta.view.label) +
          "</div><h2>" +
          esc(meta.view.label) +
          "</h2>" +
          '<div class="toolbar"><input type="search" id="q" placeholder="Search ' +
          esc(meta.view.label) +
          '…" value="' +
          esc(q || "") +
          '">' +
          note +
          '</div><div class="table-wrap"><table><thead><tr>' +
          head +
          "</tr></thead><tbody>" +
          body +
          "</tbody></table></div>"
      );
      var input = document.getElementById("q");
      var t;
      input.addEventListener("input", function () {
        clearTimeout(t);
        t = setTimeout(function () {
          location.hash = "#/e/" + name + (input.value ? "?q=" + encodeURIComponent(input.value) : "");
        }, 250);
      });
      Array.prototype.forEach.call(document.querySelectorAll("tbody tr"), function (tr) {
        tr.addEventListener("click", function () {
          location.hash = "#/e/" + name + "/" + encodeURIComponent(tr.getAttribute("data-id"));
        });
      });
    });
  }

  function lineItemsTable(items) {
    var keys = ["Description", "Quantity", "UnitAmount", "AccountCode", "TaxType", "TaxAmount", "LineAmount"];
    var present = keys.filter(function (k) {
      return items.some(function (it) {
        return it[k] != null;
      });
    });
    var head = present
      .map(function (k) {
        return "<th>" + esc(k) + "</th>";
      })
      .join("");
    var body = items
      .map(function (it) {
        return (
          "<tr>" +
          present
            .map(function (k) {
              var money = k === "UnitAmount" || k === "LineAmount" || k === "TaxAmount";
              return "<td" + (money ? ' class="num"' : "") + ">" + esc(money ? fmtMoney(it[k]) : it[k]) + "</td>";
            })
            .join("") +
          "</tr>"
        );
      })
      .join("");
    return '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  function journalLinesTable(lines) {
    var keys = ["AccountCode", "AccountName", "Description", "TaxType", "NetAmount", "GrossAmount", "TaxAmount", "LineAmount"];
    var present = keys.filter(function (k) {
      return lines.some(function (it) {
        return it[k] != null;
      });
    });
    var head = present.map(function (k) { return "<th>" + esc(k) + "</th>"; }).join("");
    var body = lines
      .map(function (it) {
        return (
          "<tr>" +
          present
            .map(function (k) {
              var money = /Amount$/.test(k);
              return "<td" + (money ? ' class="num"' : "") + ">" + esc(money ? fmtMoney(it[k]) : it[k]) + "</td>";
            })
            .join("") +
          "</tr>"
        );
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

      var rows = [];
      Object.keys(rec).forEach(function (k) {
        if (k.charAt(0) === "_") return;
        var v = rec[k];
        if (v == null || v === "") return;
        if (Array.isArray(v)) return;
        if (typeof v === "object") {
          if (v.Name) rows.push("<dt>" + esc(k) + "</dt><dd>" + esc(v.Name) + "</dd>");
          return;
        }
        var disp = /DateUTC$/.test(k) || k === "Date" || k === "DueDate" || k === "JournalDate" ? fmtDateTime(v) : v;
        rows.push("<dt>" + esc(k) + "</dt><dd>" + esc(disp) + "</dd>");
      });

      var blocks = "";
      if (Array.isArray(rec.LineItems) && rec.LineItems.length)
        blocks += '<section class="block"><h3>Line items</h3>' + lineItemsTable(rec.LineItems) + "</section>";
      if (Array.isArray(rec.JournalLines) && rec.JournalLines.length)
        blocks += '<section class="block"><h3>Journal lines</h3>' + journalLinesTable(rec.JournalLines) + "</section>";
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
    var hash = location.hash || "#/";
    var qIndex = hash.indexOf("?q=");
    var q = "";
    if (qIndex !== -1) {
      q = decodeURIComponent(hash.slice(qIndex + 3));
      hash = hash.slice(0, qIndex);
    }
    var parts = hash.replace(/^#\//, "").split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 0) return viewHome();
    if (parts[0] === "reports") return viewReports();
    if (parts[0] === "report" && parts.length >= 3) return viewReport(parts[1], parts[2]);
    if (parts[0] === "e" && parts.length === 2) return viewList(parts[1], q);
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

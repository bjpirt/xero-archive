import path from "node:path";
import { login } from "./auth";
import { runArchive, runHistoryBackfill, adoptAttachments } from "./archive";
import { generateSite, generateLanding, findArchivedStores } from "./site";
import { serve } from "./serve";
import { Store } from "./store";
import { CONFIG } from "./config";
import { log } from "./log";

async function buildSites(stores: Store[]): Promise<void> {
  if (stores.length === 0) {
    log.warn("No archived organisations found in data/. Run `npm run archive` first.");
    return;
  }
  const landing: { dir: string; name: string }[] = [];
  for (const store of stores) {
    await generateSite(store);
    landing.push({ dir: path.basename(store.tenantDir), name: store.tenantName });
  }
  await generateLanding(landing);
  log.ok(`Landing page: site/index.html (${landing.length} org(s))`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "help";
  const flags = process.argv.slice(3);
  if (flags.includes("--refresh-attachments")) CONFIG.refreshAttachments = true;
  if (flags.includes("--skip-attachments")) CONFIG.skipAttachments = true;
  if (flags.includes("--attachments-only")) CONFIG.attachmentsOnly = true;

  switch (cmd) {
    case "auth":
      await login();
      break;

    case "archive":
      await runArchive();
      log.ok("Archive complete. Build the site with `npm run site`.");
      break;

    case "history":
      await runHistoryBackfill(flags.includes("--refresh"));
      break;

    case "adopt-attachments":
      await adoptAttachments(await findArchivedStores());
      break;

    case "site":
      await buildSites(await findArchivedStores());
      log.info("View it with `npm run serve`.");
      break;

    case "all": {
      const stores = await runArchive();
      await buildSites(stores);
      log.info("Starting local server…");
      serve();
      break;
    }

    case "serve":
      serve();
      break;

    default:
      console.log(
        [
          "Xero Archive — extract & browse historical Xero data",
          "",
          "Usage: npm run <command>",
          "",
          "  auth      One-time browser sign-in (PKCE); stores a refresh token",
          "  archive   Pull all data + attachments to data/ (incremental on re-run)",
          "            records first, then reports, then attachments last",
          "            -- --skip-attachments     records/journals/reports only (cheap)",
          "            -- --attachments-only     just the attachment pass",
          "            -- --refresh-attachments  re-check attachments already stored",
          "  history   Backfill History & Notes for every archived document (resumable)",
          "            add -- --refresh to re-fetch all history from scratch",
          "  adopt-attachments",
          "            One-off, no API calls: mark already-downloaded attachments as",
          "            complete so the next archive doesn't re-list them",
          "  site      Generate the browsable HTML microsite into site/",
          "  all       archive + site + serve, in one go",
          "  serve     Serve the generated site locally and open it",
          "",
          "First time:  cp .env.example .env  (add your Client ID)  →  npm install  →  npm run auth  →  npm run all",
          "History:     npm run archive  →  npm run history  →  npm run site   (history is off by default)",
        ].join("\n"),
      );
  }
}

main().catch((e) => {
  log.error((e as Error).message);
  process.exitCode = 1;
});

import { chromium } from "playwright";

const OUT = "/tmp/rp-shots";
const BASE = "http://localhost:4173";

const errors = [];
async function shot(page, url, path, waitMs, label) {
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${label}] ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => errors.push(`[${label}] pageerror: ${String(e).slice(0, 200)}`));
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => errors.push(`[${label}] goto: ${String(e).slice(0,120)}`));
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: `${OUT}/${path}` });
  console.log("saved", path);
}

const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--disable-gpu-sandbox"],
});

// --- mobile 390x844 ---
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
  });
  const page = await ctx.newPage();
  const gl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  console.log("mobile webgl2:", gl);

  await shot(page, `${BASE}/`, "mobile-title.png", 7000, "mobile-title");
  // loadout
  await page.click("#btn-start").catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/mobile-loadout.png` });
  console.log("saved mobile-loadout.png");

  await shot(page, `${BASE}/?artcheck=graveyard`, "mobile-graveyard.png", 9000, "mobile-graveyard");
  await shot(page, `${BASE}/?artcheck=city`, "mobile-city.png", 9000, "mobile-city");
  await ctx.close();
}

// --- desktop 1440x900 ---
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const gl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  console.log("desktop webgl2:", gl);
  await shot(page, `${BASE}/`, "desktop-title.png", 7000, "desktop-title");
  await shot(page, `${BASE}/?artcheck=graveyard`, "desktop-graveyard.png", 9000, "desktop-graveyard");
  await ctx.close();
}

await browser.close();
console.log("ERRORS:", errors.length ? "\n" + errors.join("\n") : "none");

import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

const promptTitle = "GPT-4 Technical Architect";
const plaintext = "E2E unlocked prompt body.";
const contentHash = createHash("sha256").update(plaintext).digest("hex");

test("buyer connects, browses, buys, signs, and unlocks without real funds", async ({
  page,
}) => {
  const calls = { challenge: 0, unlock: 0 };

  await page.route("**/api/auth/challenge", async (route) => {
    calls.challenge += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        token: "e2e-challenge-token",
        challenge: "Sign this deterministic PromptHash challenge",
        nonce: "e2e-nonce",
        expiresAt: Date.now() + 60_000,
      }),
    });
  });

  await page.route("**/api/prompts/unlock", async (route) => {
    calls.unlock += 1;
    const request = route.request().postDataJSON();
    expect(request.signedMessage).toBe("e2e-signed-challenge");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        promptId: "1",
        title: promptTitle,
        contentHash,
        plaintext,
      }),
    });
  });

  await page.goto("/browse?e2e=1");
  await expect(page.getByText(promptTitle).first()).toBeVisible();
  await page.getByRole("button", { name: `Open ${promptTitle}` }).click();

  const purchase = page.getByRole("button", { name: /confirm & purchase/i });
  await expect(purchase).toBeDisabled();
  await expect(page.getByText(plaintext)).toHaveCount(0);

  await page.getByRole("button", { name: "Close prompt modal" }).click();
  await page.getByRole("button", { name: "Connect Wallet" }).first().click();
  await page.getByRole("button", { name: /E2E Mock Wallet/i }).click();
  await expect(
    page.getByRole("button", { name: /GBUYER/i }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: `Open ${promptTitle}` }).click();
  await expect(page.getByText("Secure Purchase")).toBeVisible();
  await expect(page.getByText(plaintext)).toHaveCount(0);
  await page.getByRole("button", { name: /confirm & purchase/i }).click();

  await expect(page.getByText(plaintext)).toBeVisible({ timeout: 15_000 });
  expect(calls).toEqual({ challenge: 1, unlock: 1 });
});

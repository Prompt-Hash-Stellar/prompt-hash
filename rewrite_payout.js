const fs = require('fs');

let content = fs.readFileSync('src/pages/profile/PayoutSettingsPage.tsx', 'utf8');

content = content.replace(/import { useState } from "react";/, `import { useState, useEffect } from "react";`);

// Remove PAYOUT_STORAGE_KEY and loadPayoutPreferences
content = content.replace(/const PAYOUT_STORAGE_KEY = [\s\S]*?function loadPayoutPreferences\([\s\S]*?\} catch \{\n    return null;\n  \}\n}\n/, '');

// Replace component content up to handleSave
const oldComponentStart = `  const { address, network } = useWallet();
  const { xlm, isLoading: isBalanceLoading } = useWalletBalance();

  const savedPrefs = address ? loadPayoutPreferences(address) : null;

  const [payoutAddress, setPayoutAddress] = useState(
    savedPrefs?.payoutAddress ?? address ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!address) return;

    setSaveError(null);
    setSaved(false);
    setSaving(true);

    try {
      await new Promise((r) => setTimeout(r, 600));
      localStorage.setItem(
        PAYOUT_STORAGE_KEY(address),
        JSON.stringify({ payoutAddress: payoutAddress.trim() || address }),
      );
      setSaved(true);
    } catch (err) {
      setSaveError(
        err instanceof Error
          ? err.message
          : "Failed to save payout preferences.",
      );
    } finally {
      setSaving(false);
    }
  };`;

const newComponentStart = `  const { address, network, signMessage } = useWallet();
  const { xlm, isLoading: isBalanceLoading } = useWalletBalance();

  const [payoutAddress, setPayoutAddress] = useState("");
  const [pendingPayoutAddress, setPendingPayoutAddress] = useState<string | null>(null);
  const [effectiveAt, setEffectiveAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }
    
    setLoading(true);
    fetch(\`/api/user/\${address}/payout-settings\`)
      .then((res) => res.json())
      .then((data) => {
        setPayoutAddress(data.payoutAddress || address);
        setPendingPayoutAddress(data.pendingPayoutAddress || null);
        setEffectiveAt(data.payoutAddressEffectiveAt ? new Date(data.payoutAddressEffectiveAt) : null);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setPayoutAddress(address);
        setLoading(false);
      });
  }, [address]);

  const handleSave = async () => {
    if (!address) return;
    if (!signMessage) {
      setSaveError("Wallet does not support message signing.");
      return;
    }

    setSaveError(null);
    setSaved(false);
    setSaving(true);

    try {
      const targetAddress = payoutAddress.trim() || address;
      const timestamp = Date.now();
      const messageToSign = \`prompt-hash:update-payout:\${targetAddress}:\${timestamp}\`;
      
      const signatureObj = await signMessage(messageToSign);
      if (!signatureObj) {
        throw new Error("User declined message signing.");
      }
      const signatureBase64 = typeof signatureObj === 'string' ? signatureObj : signatureObj.signedMessage;
      
      if (!signatureBase64) {
        throw new Error("Failed to extract signature.");
      }

      const response = await fetch(\`/api/user/\${address}/payout-settings\`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payoutAddress: targetAddress,
          signature: signatureBase64,
          signedMessage: messageToSign,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to update payout settings.");
      }

      setPayoutAddress(data.payoutAddress || address);
      setPendingPayoutAddress(data.pendingPayoutAddress || null);
      setEffectiveAt(data.payoutAddressEffectiveAt ? new Date(data.payoutAddressEffectiveAt) : null);
      
      setSaved(true);
    } catch (err) {
      setSaveError(
        err instanceof Error
          ? err.message
          : "Failed to save payout preferences.",
      );
    } finally {
      setSaving(false);
    }
  };`;

content = content.replace(oldComponentStart, newComponentStart);

// Inject UI for cooling off window
const oldUI = `                <div className="space-y-2">
                  <label
                    htmlFor="payoutAddress"
                    className="text-sm font-medium text-slate-200"
                  >
                    Payout XLM Address
                  </label>
                  <Input
                    id="payoutAddress"
                    value={payoutAddress}
                    onChange={(e) => {
                      setPayoutAddress(e.target.value);
                      setSaved(false);
                      setSaveError(null);
                    }}
                    placeholder={address}
                    className="border-white/10 bg-white/[0.04] text-slate-100 font-mono"
                  />
                  <p className="text-xs text-slate-500">
                    Leave empty to use your connected wallet address.
                  </p>
                </div>`;

const newUI = \`                <div className="space-y-2">
                  <label
                    htmlFor="payoutAddress"
                    className="text-sm font-medium text-slate-200"
                  >
                    Payout XLM Address
                  </label>
                  <Input
                    id="payoutAddress"
                    value={payoutAddress}
                    onChange={(e) => {
                      setPayoutAddress(e.target.value);
                      setSaved(false);
                      setSaveError(null);
                    }}
                    placeholder={address || ""}
                    className="border-white/10 bg-white/[0.04] text-slate-100 font-mono"
                  />
                  <p className="text-xs text-slate-500">
                    Leave empty to use your connected wallet address. Changes take 24 hours to take effect.
                  </p>
                  
                  {pendingPayoutAddress && effectiveAt && (
                    <div className="mt-4 p-3 rounded bg-amber-500/10 border border-amber-500/20 text-amber-200/90 text-sm">
                      <p className="font-semibold text-amber-400">Pending Change</p>
                      <p>New address: <span className="font-mono bg-black/20 px-1 rounded">{pendingPayoutAddress}</span></p>
                      <p>Effective after: {effectiveAt.toLocaleString()}</p>
                    </div>
                  )}
                </div>\`;

content = content.replace(oldUI, newUI);

fs.writeFileSync('src/pages/profile/PayoutSettingsPage.tsx', content);

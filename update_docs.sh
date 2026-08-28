#!/bin/bash

# Update Table of Contents
sed -i 's/- \[Step 3: List Your First Prompt\]/- \[Step 3: Configure Payout Settings\](#step-3-configure-payout-settings)\n- \[Step 4: List Your First Prompt\]/' docs/creator-onboarding.md

# Update the heading
sed -i 's/## Step 3: List Your First Prompt/## Step 4: List Your First Prompt/' docs/creator-onboarding.md

# Insert the new section before the new Step 4
sed -i '/## Step 4: List Your First Prompt/i \
## Step 3: Configure Payout Settings\
\
Before you start earning, you may want to configure where your XLM from sales is sent. By default, it is sent to your connected wallet.\
\
### Payout Destination Rules\
\
To ensure safe marketplace settlement, your payout destination must be:\
1. **A valid Stellar address** (starting with `G` or `M`)\
2. **Fully funded** on the Stellar network (contains the minimum XLM reserve)\
3. **Memo-compatible**: If your exchange requires a memo to receive deposits, you **must** use a Muxed Account address (starts with `M...`) which has the memo embedded. Plain `G...` addresses for memo-required accounts will be rejected by our verification system to protect your funds.\
\
To update your payout settings, visit your **Creator Profile** > **Payout Settings**.\
\
---\
' docs/creator-onboarding.md

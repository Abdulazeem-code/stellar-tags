# Flash loan fees

Flash loan fees rise with the share of the selected token's reserves being
borrowed. The utilization is `amount / provider_token_balance` immediately
before disbursement. The fee rate starts at 5 bps, rises linearly to 10 bps at
80% utilization, then rises linearly to a 50 bps cap at 100%. The token transfer
fee is rounded up to the token's smallest unit.

The quote method is `get_flash_loan_fee(amount, token_address)`. The token
address is required because this provider can lend multiple assets, each with
an independent reserve balance. An amount-only quote cannot determine
utilization in that model. The loan path uses the same calculation against the
balance it reads before transferring funds. `flash_fee(amount)` remains as a
legacy base-fee quote; it does not estimate the dynamic fee and should not be
used to prepare a repayment.

The model treats the provider's full token balance as available reserves. It
does not include reserved liquidity, utilization from other protocols, or an
oracle price adjustment. These can be layered on if the provider later tracks
withdrawable versus reserved balances.

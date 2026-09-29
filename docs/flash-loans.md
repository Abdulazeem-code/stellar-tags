# Flash loans

The `flash_loan` contract lends tokens that it already holds. A caller chooses
a borrower contract, token, amount, and optional data. The caller must approve
the request.

The fee is 0.05% of the borrowed amount, rounded up to the token's smallest
unit. For example, borrowing 10,000 units costs 5 units.

## Borrower callback

The borrower must provide this function:

```text
on_flash_loan(lender, initiator, token_address, amount, fee, data)
```

During the callback, the borrower can use the tokens and must return `amount +
fee` to `lender`. If the callback is missing, fails, calls for another flash
loan, or returns too little, the complete loan is undone. This includes the
initial token transfer and any state changes made during the callback.

The provider must be funded by transferring tokens to its contract address
before a loan is requested. A successful loan leaves the fee in the provider,
adding it to the liquidity available for later loans.

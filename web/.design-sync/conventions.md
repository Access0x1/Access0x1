# Access0x1 Web — build conventions

## Setup: two wrappers, both load-bearing

1. **Provider**: wrap every tree in `<Providers>` (exported on the bundle) — it
   supplies wagmi + react-query context. Wallet-aware components
   (`BuyerConnectButton`, `FundButton`, `CheckoutCard`, `TokenPicker`) throw or
   render dead without it. With no wallet extension present they render their
   honest disconnected states — that is correct, not broken.
2. **Dark chassis**: the app's look is "night water" — a near-black
   `bg-background` with light `text-foreground`, applied globally by the real
   app. Your outermost container must carry `bg-background text-foreground`
   or text renders near-invisible. Build dark-first; there is no light theme
   toggle.

**The `.light` island exception**: white-label commerce surfaces
(`CheckoutCard`, `BrandPreview`) are DESIGNED to sit as bright cards on the
dark chassis. Wrap exactly those in
`<div className="light rounded-2xl border border-border bg-card p-6">` — the
`.light` class re-maps every token inside it. Never apply `.light` at the page
root.

## Styling idiom: Tailwind utilities over shadcn-style CSS variables

All colors are HSL-channel CSS variables composed by utility classes — never
hardcode hex values. The working vocabulary (all verified in the shipped CSS):

| Family | Classes |
|---|---|
| Surfaces | `bg-background` `bg-card` `bg-secondary` `bg-popover` |
| Text | `text-foreground` `text-card-foreground` `text-muted-foreground` |
| Brand accent (cyan "rail") | `bg-primary` `text-primary-foreground` `bg-rail` `text-rail` |
| Secondary accent (teal) | `bg-accent` |
| States | `text-destructive` `bg-destructive` + `--success` via `hsl(var(--success))` |
| Borders | `border-border` (also the global default) |
| Legacy aliases | `text-ink` == `text-foreground` (37 call sites use it; fine to use) |
| Radius | `rounded-lg` = `var(--radius)` (14px) · `rounded-2xl` for cards/islands |
| Type | `font-sans` (Inter) for UI/body · `font-display` (Space Grotesk) for headlines/wordmark |

Special: `.ax1-shimmer` is the gold sweep reserved for the L4 "Super Verified"
badge — never decorate anything else with it.

## Where the truth lives

- `styles.css` → `_ds_bundle.css` (the full compiled token + utility set) —
  read it before inventing a class.
- `guidelines/` — the brand corpus: `brand-system.md`, `design-tokens.md`,
  `checkout-ux-guidelines.md`, `motion-spec.md`, `logo-usage.md`.
- Per-component: each `<Name>.prompt.md` (usage + real examples) and
  `<Name>.d.ts` (the props contract).

## Idiomatic composition

```tsx
<Providers>
  <div className="bg-background text-foreground p-6">
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle className="text-base">PaymentLanes</CardTitle>
        <CardDescription>One ERC-6909 primitive, many products.</CardDescription>
      </CardHeader>
      <CardContent>
        <Badge variant="outline" className="font-mono text-[0.7rem]">PaymentLanes.sol</Badge>
      </CardContent>
      <CardFooter>
        <Button className="w-full">Confirm</Button>
      </CardFooter>
    </Card>
  </div>
</Providers>
```

Badge variants: `default` `secondary` `destructive` `outline` `success`
`level` `super`. Button variants: `default` `destructive` `outline`
`secondary` `ghost` `link`, sizes `sm` `default` `lg` `icon`. Copy tone:
plain, factual, USD-first ("29.01 USDC", "$29.00") — testnet surfaces say so
honestly.

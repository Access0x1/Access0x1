import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@access0x1/web'

// CardHeader only makes sense composed inside Card — shown in the same
// realistic context as components/marketing/FeatureGrid.tsx's real usage.
export const Default = () => (
  <Card className="h-full" style={{ maxWidth: 320 }}>
    <CardHeader>
      <div className="mb-2 flex items-center gap-2">
        <span aria-hidden="true" className="text-xl leading-none">
          🔀
        </span>
        <CardTitle className="text-base">PaymentLanes</CardTitle>
      </div>
      <CardDescription className="leading-relaxed">
        Subscriptions, invoices, and gift cards — one ERC-6909 primitive, many
        products.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">Backed by PaymentLanes.sol</p>
    </CardContent>
  </Card>
)

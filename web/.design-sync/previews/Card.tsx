import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@access0x1/web'

// Ported from components/marketing/FeatureGrid.tsx's real feature-card composition.
export const Default = () => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 20, maxWidth: 640 }}>
    <Card className="h-full transition-colors hover:border-primary/50">
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
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          PaymentLanes.sol
        </Badge>
      </CardContent>
    </Card>
    <Card className="h-full transition-colors hover:border-primary/50">
      <CardHeader>
        <div className="mb-2 flex items-center gap-2">
          <span aria-hidden="true" className="text-xl leading-none">
            🔐
          </span>
          <CardTitle className="text-base">SessionGrant</CardTitle>
        </div>
        <CardDescription className="leading-relaxed">
          ERC-7702/6492 delegated sessions so an agent can act on your behalf,
          scoped and revocable.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          SessionGrant.sol
        </Badge>
      </CardContent>
    </Card>
  </div>
)

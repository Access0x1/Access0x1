import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@access0x1/web'

// CardContent only makes sense composed inside Card — shown in the same
// realistic context as components/marketing/FeatureGrid.tsx's real usage.
export const Default = () => (
  <Card className="h-full" style={{ maxWidth: 320 }}>
    <CardHeader>
      <CardTitle className="text-base">PaymentLanes</CardTitle>
      <CardDescription className="leading-relaxed">
        Subscriptions, invoices, and gift cards — one ERC-6909 primitive.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Badge variant="outline" className="font-mono text-[0.7rem]">
        PaymentLanes.sol
      </Badge>
    </CardContent>
  </Card>
)

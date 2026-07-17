import { Card, CardDescription, CardHeader, CardTitle } from '@access0x1/web'

// CardDescription only makes sense composed inside CardHeader/Card — shown in
// the same realistic context as components/marketing/FeatureGrid.tsx.
export const Default = () => (
  <Card className="h-full" style={{ maxWidth: 320 }}>
    <CardHeader>
      <CardTitle className="text-base">Chainlink price feeds</CardTitle>
      <CardDescription className="leading-relaxed">
        Every settlement prices in USD via a live Chainlink feed, read in the
        same transaction that moves funds — no stale-price window.
      </CardDescription>
    </CardHeader>
  </Card>
)

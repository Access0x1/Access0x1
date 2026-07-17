import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@access0x1/web'

// CardTitle only makes sense composed inside CardHeader/Card — shown in the
// same realistic context as components/marketing/FeatureGrid.tsx's real usage.
export const Default = () => (
  <Card className="h-full" style={{ maxWidth: 320 }}>
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
  </Card>
)

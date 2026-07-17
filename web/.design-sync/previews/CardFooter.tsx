import { Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@access0x1/web'

// No real CardFooter usage exists in the repo yet (grepped — unused so far).
// Composed from the component source + the Card family's own real usage
// pattern: a settlement summary card with a confirm action, matching how the
// app's other action rows pair a CardContent block with a primary Button.
export const Default = () => (
  <Card className="h-full" style={{ maxWidth: 320 }}>
    <CardHeader>
      <CardTitle className="text-base">Confirm payment</CardTitle>
      <CardDescription className="leading-relaxed">50.00 USDC · Base Sepolia</CardDescription>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">Router fee: 0.50 USDC</p>
    </CardContent>
    <CardFooter>
      <Button className="w-full">Confirm</Button>
    </CardFooter>
  </Card>
)

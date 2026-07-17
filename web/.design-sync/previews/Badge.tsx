import { Badge } from '@access0x1/web'

export const Variants = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    <Badge>Default</Badge>
    <Badge variant="secondary">Secondary</Badge>
    <Badge variant="destructive">Destructive</Badge>
    <Badge variant="outline">Outline</Badge>
    <Badge variant="success">Verified</Badge>
    <Badge variant="level" data-level={2}>
      L2
    </Badge>
    <Badge variant="super" data-level={4}>
      Super Verified
    </Badge>
  </div>
)

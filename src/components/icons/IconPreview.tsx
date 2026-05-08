import * as Icons from './index'

export default function IconPreview() {
  const iconNames = Object.keys(Icons)
  
  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 18, marginBottom: 20 }}>图标库预览</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 16 }}>
        {iconNames.map((name) => {
          const IconComponent = Icons[name as keyof typeof Icons]
          return (
            <div key={name} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <IconComponent size={24} color="#4CAF50" />
              <span style={{ fontSize: 10, color: '#999', textAlign: 'center' }}>{name.replace('Icon', '')}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
import { motion } from 'framer-motion'

export default function BreathingCircle({ size = 80 }: { size?: number }) {
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <motion.div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background: 'radial-gradient(circle, var(--primary-light), var(--primary))',
          opacity: 0.6,
        }}
        animate={{ scale: [1, 1.3, 1], opacity: [0.4, 0.8, 0.4] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        style={{
          position: 'absolute',
          inset: size * 0.2,
          borderRadius: '50%',
          background: 'radial-gradient(circle, var(--secondary-light), var(--secondary))',
          opacity: 0.5,
        }}
        animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut', delay: 0.5 }}
      />
      <div style={{
        position: 'absolute', inset: size * 0.35,
        borderRadius: '50%', background: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <motion.span
          style={{ fontSize: size * 0.16, fontWeight: 700, color: 'var(--primary-dark)' }}
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        >
          呼吸
        </motion.span>
      </div>
    </div>
  )
}

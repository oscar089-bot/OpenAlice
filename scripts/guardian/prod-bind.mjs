export function resolveProdBindHost(env, launcher) {
  const configured = env.OPENALICE_BIND_HOST?.trim()
  if (configured) return configured
  return launcher === 'cli' || launcher === 'cli-server' ? '127.0.0.1' : '0.0.0.0'
}

export function resolveProdAdvertisedHost(bindHost) {
  return bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost
}

export function withProdAliceBindHost(env, bindHost) {
  return { ...env, OPENALICE_BIND_HOST: bindHost }
}
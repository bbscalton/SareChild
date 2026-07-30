const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generatePairingCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length]
  }
  return out
}

export const DEFAULT_KEYWORDS = {
  sex: ['sex', 'nude', 'nudes', 'naked', 'porn', 'onlyfans', 'send pics', 'send nudes'],
  drugs: ['weed', 'cocaine', 'heroin', 'fentanyl', 'meth', 'ecstasy', 'molly', 'buy drugs', 'dealer'],
  grooming: [
    "don't tell your parents",
    'dont tell your parents',
    'keep this secret',
    'our secret',
    'meet me alone',
    'send me a photo',
    'how old are you really',
  ],
  self_harm: ['kill myself', 'suicide', 'self harm', 'self-harm', 'want to die', 'cutting myself'],
  violence: ['bring a knife', 'bring a gun', 'shoot up', 'beat you up'],
}

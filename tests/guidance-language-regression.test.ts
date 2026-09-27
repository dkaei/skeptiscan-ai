import { describe, expect, it } from 'vitest';
import { selectGuidance } from '../server/guidance';

const now = new Date('2026-09-27T00:00:00.000Z');
const ids = (text: string) => selectGuidance(text, now).map(item => item.id.replace('guidance-', '')).sort();

// These exercise retrieval scope, not empirical scam labels. Both halves of
// each contrast matter: a refusal must not hide a later affirmative request.
describe('guidance language regression: refusals and coordinated negatives', () => {
  it.each([
    'We declined to disclose our banking credentials.',
    'I am refusing to download the technical support software.',
    'Nobody was asking us to grant or enable remote access.',
    'We refuse to download AnyDesk or provide our banking OTP.',
    'The seller says never open the payment website or scan its QR code.',
    'The delivery notice says not to click the payment link or transfer a fee.',
    'There is no additional delivery charge to pay.',
    'There is no account password to provide.',
    'Your banking code must not be sent to anyone.',
    'The redelivery fee should never be paid.',
    'This Digital Token request must not be approved.',
    'My bank sent an account code to my phone. I entered it in my own app.',
    'WhatsApp sent me a registration code. I entered it only in WhatsApp.',
  ])('does not retrieve a source for an absent or refused demand: %s', text => {
    expect(ids(text)).toEqual([]);
  });

  it.each<[string, string[]]>([
    ['We declined to disclose our banking credentials, but the agent says send your login code here.', ['account-credentials']],
    ['I refuse to download AnyDesk, but the caller asks me to provide my banking OTP.', ['account-credentials']],
    ['There is no extra delivery charge to pay, but the courier asks me to scan the payment QR code.', ['parcel-payment']],
    ['Never open a delivery payment link and please install AnyDesk for remote control.', ['remote-access']],
    ['No one was asking me to grant remote control. Now send the WhatsApp registration code to the helper.', ['whatsapp-account']],
    ['Your account password has to be provided to the agent.', ['account-credentials']],
    ['Your WhatsApp registration code is required to be forwarded to the helper.', ['whatsapp-account']],
    ['The parcel release fee should be transferred immediately.', ['parcel-payment']],
    ['This Digital Token request must be approved now.', ['account-credentials']],
    ['Do not refuse to share your bank login code with the caller.', ['account-credentials']],
    ['Do not delay downloading the technical support application.', ['remote-access']],
  ])('preserves the affirmative request: %s', (text, expected) => {
    expect(ids(text)).toEqual(expected);
  });
});

describe('passive request adverbs preserve polarity', () => {
  it.each(['directly', 'immediately', 'now'])('distinguishes affirmative and negative sharing with %s after be', adverb => {
    expect(ids(`Your banking OTP must be ${adverb} sent to the caller.`)).toEqual(['account-credentials']);
    expect(ids(`Your banking OTP must not be ${adverb} sent to the caller.`)).toEqual([]);
  });

  it.each(['also', 'now'])('distinguishes affirmative and negative payment with %s before be', adverb => {
    expect(ids(`The courier says a redelivery fee must ${adverb} be paid.`)).toEqual(['parcel-payment']);
    expect(ids(`The courier says a redelivery fee must not ${adverb} be paid.`)).toEqual([]);
  });

  it('retains a later demand after a negative passive approval', () => {
    expect(ids('The Digital Token request must not be immediately approved, but the courier asks me to pay S$4 for redelivery.')).toEqual(['parcel-payment']);
  });

  it('retains a later sharing demand after negative passive payment advice', () => {
    expect(ids('The parcel fee should never be directly paid to the caller; instead send your bank login code to the agent.')).toEqual(['account-credentials']);
  });
});

import type { ReactNode } from 'react';
import { Icon } from './Icon';
import s from './SupportPanel.module.css';

// Official guidance reviewed 27 September 2026. Shared by Home and Help.
export const SUPPORT_SOURCES = {
  helpline: 'https://www.scamshield.gov.sg/check-for-scams/scamshield-helpline/',
  recovery: 'https://www.scamshield.gov.sg/i-have-been-scammed/',
  device: 'https://www.scamshield.gov.sg/installed-a-malicious-app/',
  report: 'https://eservices1.police.gov.sg/phub/eservices/landingpage/police-report',
  updates: 'https://www.scamshield.gov.sg/resources/scam-bulletins/',
};

export function OfficialLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}<Icon name="external" /><span className={s.sr}> (opens in a new tab)</span></a>;
}

export function ScamShieldContact() {
  return <a className={s.helpline} href="tel:1799">
    <span className={s.phoneIcon}><img src="/assets/call.svg" alt="" /></span>
    <span className={s.helplineText}><strong>ScamShield helpline</strong><span>Scam advice, 24/7</span></span>
    <span className={s.call}>Call 1799</span>
  </a>;
}

export function RecoverySteps() {
  return <>
    <ol>
      <li><strong>Contact your bank now</strong><p>If money or banking details are involved, use your bank’s official app or the number on your card. If someone may control your device, use another trusted device. Don’t wait for an AI check.</p></li>
      <li><strong>Keep the evidence</strong><p>Save messages and transaction records, then make a police report.</p><OfficialLink href={SUPPORT_SOURCES.report}>File a police report</OfficialLink></li>
      <li><strong>Secure affected accounts</strong><p>Change compromised passwords through the official service and enable two-factor authentication.</p></li>
    </ol>
    <div className={s.source}><OfficialLink href={SUPPORT_SOURCES.recovery}>ScamShield recovery guide</OfficialLink></div>
  </>;
}

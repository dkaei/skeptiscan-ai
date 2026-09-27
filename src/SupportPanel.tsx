import { Icon } from './Icon';
import { OfficialLink, RecoverySteps, ScamShieldContact, SUPPORT_SOURCES } from './SupportContent';
import s from './SupportPanel.module.css';

export default function SupportPanel() {
  return <section className={s.support} aria-labelledby="support-title">
    <div className={s.heading}><h2 id="support-title">Get help</h2><span>Singapore</span></div>
    <div className={s.panel}>
      <ScamShieldContact />
      <details className={s.guide}>
        <summary><span>Sent money or shared details?</span><Icon name="down" /></summary>
        <div className={s.content}>
          <RecoverySteps />
          <p className={s.emergency}>For urgent police assistance, call <a href="tel:999">999</a>.</p>
        </div>
      </details>
      <details className={s.guide}>
        <summary><span>Before you act</span><Icon name="down" /></summary>
        <div className={s.content}>
          <ul className={s.tips}>
            <li><strong>Pause the request</strong><p>Keep login codes private. Don’t approve a sign-in you didn’t start.</p></li>
            <li><strong>Verify independently</strong><p>Open the official app yourself, or use contact details you already know.</p></li>
            <li><strong>Talk it through</strong><p>If you’re unsure, call 1799 before paying or granting access.</p></li>
          </ul>
          <div className={s.source}><OfficialLink href={SUPPORT_SOURCES.helpline}>About the helpline</OfficialLink></div>
        </div>
      </details>
    </div>
    <div className={s.updates}><OfficialLink href={SUPPORT_SOURCES.updates}>Scam updates from ScamShield</OfficialLink></div>
  </section>;
}

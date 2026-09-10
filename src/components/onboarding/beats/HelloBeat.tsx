// Beat 1: who you are. Name and email go to the workspace profile (the
// sidebar footer reads them back) and to analytics identity. Both optional;
// "Maybe later" moves on without either.
import { useState } from "react";
import { identifyEmail, track } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import { inputClass, PrimaryButton, QuietButton, staggerIndex, type BeatProps } from "./shared";

export function HelloBeat({ onNext, onSkip }: BeatProps) {
  const { dispatch } = useStore();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  const saveProfile = () => {
    const trimmedEmail = email.trim().toLowerCase();
    identifyEmail(trimmedEmail);
    // persisted server-side (~/.openmausbot/config.json); the response is
    // the fresh config status, folded straight into the store
    void api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ profile: { name: name.trim(), email: trimmedEmail } }),
    })
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
    onNext();
  };

  return (
    <div className="stagger flex flex-col items-center">
      <p className="animate-rise mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary" style={staggerIndex(0)}>
        {t("onboarding.intro")}
      </p>
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("onboarding.name")}
        className={`animate-rise mt-5 ${inputClass}`}
        style={staggerIndex(1)}
      />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && valid && saveProfile()}
        placeholder="you@example.com"
        className={`animate-rise mt-3 ${inputClass}`}
        style={staggerIndex(2)}
      />
      <PrimaryButton onClick={saveProfile} disabled={!valid} className="animate-rise mt-3" style={staggerIndex(3)}>
        {t("onboarding.continue")}
      </PrimaryButton>
      <QuietButton
        onClick={() => {
          track("email_skipped");
          onSkip();
        }}
        className="animate-rise mt-3"
        style={staggerIndex(4)}
      >
        {t("onboarding.maybeLater")}
      </QuietButton>
    </div>
  );
}

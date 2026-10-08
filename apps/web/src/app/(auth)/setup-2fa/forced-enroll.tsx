"use client";

import { EnrollTwoFactor } from "@/components/account/two-factor";

export function ForcedEnroll() {
  // full reload so the server layout sees the new session state
  return <EnrollTwoFactor onEnrolled={() => window.location.replace("/dashboard")} />;
}

/** Settings tabs everyone sees, and the ones only an Owner or Admin sees (the page renders a trigger for each). */
export const SETTINGS_TABS = ["general", "departments", "pricing", "members", "api"] as const;
export const ADMIN_SETTINGS_TABS = ["email", "notifications", "integrations", "repositories", "webhooks", "audit"] as const;

/**
 * ?tab= as a tab this person can see. Anything else (unknown, or an admin tab for a member) opens General: the page
 * renders every tab's content, so an unchecked ?tab= would show an admin panel without its trigger.
 */
export function settingsTab(requested: string | null | undefined, admin: boolean): string {
  const visible: readonly string[] = admin ? [...SETTINGS_TABS, ...ADMIN_SETTINGS_TABS] : SETTINGS_TABS;
  return requested && visible.includes(requested) ? requested : "general";
}

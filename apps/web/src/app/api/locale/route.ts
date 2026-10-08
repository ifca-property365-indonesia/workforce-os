import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { LOCALES } from "@wfos/shared";
import { body, errorResponse } from "@/lib/server/route";
import { setLocaleCookie } from "@/lib/server/locale-cookie";

const schema = z.object({ locale: z.enum(LOCALES) });

/** Language switch for signed-out pages (login, signup). Signed-in users save it with PATCH /api/me. */
export async function POST(req: NextRequest) {
  try {
    const { locale } = await body(req, schema);
    await setLocaleCookie(locale);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e, req);
  }
}

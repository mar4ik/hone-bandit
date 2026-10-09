import { handleTick } from '../../../../server/handlers.ts';
import { guard } from '../../../../server/http.ts';
import { getCtx } from '../../../../server/next-context.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Vercel Cron calls GET and sends "Authorization: Bearer <CRON_SECRET>" when that variable is set.
export const GET = (req: Request) => guard(() => handleTick(req, getCtx()));
export const POST = GET;

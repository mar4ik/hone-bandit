import { handleAdmin } from '../../../../server/handlers.ts';
import { guard } from '../../../../server/http.ts';
import { getCtx } from '../../../../server/next-context.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// The handler reads the path itself: /api/admin/experiments, /api/admin/experiments/:id, .../kill, .../resume, .../tick
export const GET = (req: Request) => guard(() => handleAdmin(req, getCtx()));
export const POST = GET;

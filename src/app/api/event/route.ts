import { handleEvent, handleOptions } from '../../../server/handlers.ts';
import { guard } from '../../../server/http.ts';
import { getCtx } from '../../../server/next-context.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = (req: Request) => guard(() => handleEvent(req, getCtx()));
export const OPTIONS = () => handleOptions();

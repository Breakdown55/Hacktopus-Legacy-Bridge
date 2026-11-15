import { Auth } from '@auth/core';
import { authConfig } from '../../../../server/auth/config';

export const runtime = 'nodejs';
const handler = (req: Request) => Auth(req, authConfig());
export { handler as GET, handler as POST };

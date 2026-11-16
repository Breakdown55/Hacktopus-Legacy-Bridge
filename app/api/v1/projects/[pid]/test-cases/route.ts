import { api } from '../../../../../../server/api/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = api.testCaseCreate;

export const GET = api.testCaseDownload;

import { api } from '../../../../server/api/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = api.projectsList;
export const POST = api.projectsCreate;

import { api } from '@/server/api/handlers';
export const runtime = 'nodejs';
export const POST = api.analysisRunCreate;
export const GET = api.analysisRunsList;

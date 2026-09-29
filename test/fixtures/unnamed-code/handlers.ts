type Handler = (req: Request) => Promise<Response>;

function withAuth(handler: Handler): Handler {
  return async (req) => handler(req);
}

export async function named(req: Request): Promise<Response> {
  return new Response(await req.text());
}

export const wrapped = withAuth(async (req) => {
  return new Response(await req.text());
});

export const bare = async (req: Request): Promise<Response> => {
  return new Response(await req.text());
};

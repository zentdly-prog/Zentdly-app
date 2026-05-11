type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
    next?: string;
  }>;
};

function getErrorMessage(error: string | undefined) {
  if (error === "config") {
    return "El login no está configurado en el servidor.";
  }

  if (error === "invalid") {
    return "Usuario o contraseña incorrectos.";
  }

  return null;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const errorMessage = getErrorMessage(params?.error);
  const nextPath = params?.next?.startsWith("/") ? params.next : "/";

  return (
    <main className="min-h-screen bg-gray-950 px-4 py-8 text-gray-100 flex items-center justify-center">
      <section className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="w-9 h-9 bg-green-500 rounded-lg flex items-center justify-center">
            <span className="text-white text-sm font-bold">Z</span>
          </div>
          <div>
            <h1 className="text-xl font-semibold">Zentdly</h1>
            <p className="text-sm text-gray-400">Acceso privado</p>
          </div>
        </div>

        <form
          action="/api/login"
          method="post"
          className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm text-gray-900"
        >
          <input type="hidden" name="next" value={nextPath} />

          <div className="space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">
                Usuario
              </label>
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                required
                autoFocus
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Contraseña
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
              />
            </div>

            {errorMessage && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {errorMessage}
              </div>
            )}

            <button
              type="submit"
              className="w-full rounded-lg bg-green-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-700"
            >
              Entrar
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

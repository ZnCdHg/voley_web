// ============================================================
// API — cómo la web habla con el servidor Flask.
//
// fetch() manda una petición HTTP y devuelve una PROMESA: algo
// que "ya llegará". Por eso las funciones llevan async/await:
// "espera aquí hasta que el servidor conteste, sin congelar
// la página mientras tanto".
// ============================================================

// Llamada genérica a la API. Ejemplos:
//   api('GET', '/api/yo')
//   api('POST', '/api/login', { usuario: 'ana', clave: '...' })
async function api(metodo, ruta, cuerpo) {
  const opciones = { method: metodo, headers: {} };
  if (cuerpo !== undefined) {
    // Los datos viajan como texto JSON, el mismo formato de localStorage
    opciones.headers['Content-Type'] = 'application/json';
    opciones.body = JSON.stringify(cuerpo);
  }

  let respuesta;
  try {
    respuesta = await fetch(ruta, opciones);
  } catch (e) {
    // Ni siquiera hubo respuesta: no hay servidor (p. ej. en GitHub Pages)
    const error = new Error('No se pudo conectar con el servidor');
    error.estado = 0;
    throw error;
  }

  const datos = await respuesta.json().catch(function () { return {}; });
  if (!respuesta.ok) {
    // El servidor contestó pero con error (401 sin sesión, 403 prohibido...)
    const error = new Error(datos.error || 'Error ' + respuesta.status);
    error.estado = respuesta.status;
    throw error;
  }
  return datos;
}

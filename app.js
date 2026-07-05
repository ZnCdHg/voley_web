// ============================================================
// MARCADOR VOLEY — lógica del partido
// Equivale al Partido de tus apps Flutter, pero en JavaScript.
// ============================================================

// ----- Reglas de cada modalidad (las tuyas de árbitro) -----
// Un "objeto" de JavaScript es como un diccionario de Python.
const MODALIDADES = {
  '4v4':   { setsParaGanar: 2, puntosSet: 25, puntosDecisivo: 15, cambioCada: null, cambioDecisivoA: 8 },
  '6v6':   { setsParaGanar: 3, puntosSet: 25, puntosDecisivo: 15, cambioCada: null, cambioDecisivoA: 8 },
  'playa': { setsParaGanar: 2, puntosSet: 21, puntosDecisivo: 15, cambioCada: 7,    cambioDecisivoCada: 5 },
};

// ----- Estado del partido -----
// "let" porque lo reasignamos al empezar cada partido nuevo.
let partido = null;

function nuevoPartido(modalidad, nombreLocal, nombreVisitante) {
  return {
    modalidad: modalidad,
    reglas: MODALIDADES[modalidad],
    nombres: [nombreLocal, nombreVisitante],  // índice 0 = local, 1 = visitante
    puntos: [0, 0],          // puntos del set en curso
    sets: [0, 0],            // sets ganados por cada equipo
    setsCerrados: [],        // resultados de sets terminados, ej. "25-20"
    ladosInvertidos: false,  // true tras un cambio de campo
    yaHuboCambioDecisivo: false, // en 4v4/6v6 el decisivo solo cambia una vez (a los 8)
    terminado: false,
  };
}

// ============================================================
// LÓGICA DE JUEGO
// ============================================================

// ¿El set en curso es el decisivo? (el último posible)
function esSetDecisivo(p) {
  // Si ambos están a un set de ganar, este es el decisivo.
  return p.sets[0] === p.reglas.setsParaGanar - 1 &&
         p.sets[1] === p.reglas.setsParaGanar - 1;
}

// ¿A cuántos puntos se juega el set actual?
function puntosObjetivo(p) {
  return esSetDecisivo(p) ? p.reglas.puntosDecisivo : p.reglas.puntosSet;
}

function sumarPunto(equipo) {           // equipo: 0 (local) o 1 (visitante)
  if (partido.terminado) return;        // partido acabado: no hacemos nada

  partido.puntos[equipo] += 1;

  // El orden importa: primero miramos si el set ha terminado,
  // y solo si NO ha terminado comprobamos el cambio de campo.
  if (comprobarFinDeSet()) {
    render();
    return;
  }
  comprobarCambioDeCampo();
  render();
}

function restarPunto(equipo) {
  if (partido.terminado) return;
  if (partido.puntos[equipo] === 0) return;  // no hay puntos negativos

  // Mismo bug que arreglamos en la app Flutter: si el punto que quitamos
  // fue el que provocó un cambio de campo, hay que deshacer ese cambio.
  const sumaPrevia = partido.puntos[0] + partido.puntos[1];
  partido.puntos[equipo] -= 1;
  deshacerCambioCampoSiProcede(sumaPrevia);
  render();
}

function deshacerCambioCampoSiProcede(sumaPrevia) {
  const p = partido;
  const decisivo = esSetDecisivo(p);

  if (p.modalidad === 'playa') {
    const cada = decisivo ? p.reglas.cambioDecisivoCada : p.reglas.cambioCada;
    if (sumaPrevia > 0 && sumaPrevia % cada === 0) cambiarDeCampo();
  } else if (decisivo && p.yaHuboCambioDecisivo && sumaPrevia === p.reglas.cambioDecisivoA) {
    p.yaHuboCambioDecisivo = false;
    cambiarDeCampo();
  }
}

function comprobarFinDeSet() {
  const objetivo = puntosObjetivo(partido);
  const [pL, pV] = partido.puntos;  // "desempaquetado", como a, b = lista en Python

  // Un set se gana llegando al objetivo CON 2 de diferencia
  let ganador = null;
  if (pL >= objetivo && pL - pV >= 2) ganador = 0;
  if (pV >= objetivo && pV - pL >= 2) ganador = 1;
  if (ganador === null) return false;

  partido.sets[ganador] += 1;
  partido.setsCerrados.push(pL + '-' + pV);

  // ¿Con este set se gana el partido?
  if (partido.sets[ganador] === partido.reglas.setsParaGanar) {
    partido.terminado = true;
  } else {
    // Set nuevo: puntos a cero y aviso
    partido.puntos = [0, 0];
    partido.yaHuboCambioDecisivo = false;
    mostrarAviso('Set para ' + partido.nombres[ganador]);
  }
  return true;
}

function comprobarCambioDeCampo() {
  const p = partido;
  const suma = p.puntos[0] + p.puntos[1];
  const decisivo = esSetDecisivo(p);

  if (p.modalidad === 'playa') {
    // Playa: cambio cada 7 puntos sumados (cada 5 en el decisivo)
    const cada = decisivo ? p.reglas.cambioDecisivoCada : p.reglas.cambioCada;
    if (suma > 0 && suma % cada === 0) cambiarDeCampo();
  } else if (decisivo && !p.yaHuboCambioDecisivo && suma === p.reglas.cambioDecisivoA) {
    // 4v4 y 6v6: un único cambio en el set decisivo, a los 8 puntos
    p.yaHuboCambioDecisivo = true;
    cambiarDeCampo();
  }
}

function cambiarDeCampo() {
  partido.ladosInvertidos = !partido.ladosInvertidos;
  mostrarAviso('🔄 ¡Cambio de campo!');
}

// ============================================================
// PANTALLA (lo que en Flutter hacía setState + build)
// ============================================================

// Guardamos referencias a los elementos del HTML.
// document.querySelector busca en la página con la misma
// sintaxis que los selectores del CSS ("#id", ".clase"...).
const pantallaInicio   = document.querySelector('#pantalla-inicio');
const pantallaMarcador = document.querySelector('#pantalla-marcador');
const paneles          = document.querySelector('#paneles');
const panelLocal       = document.querySelector('#panel-local');
const panelVisitante   = document.querySelector('#panel-visitante');
const infoSet          = document.querySelector('#info-set');
const avisoDiv         = document.querySelector('#aviso');
const finPartidoDiv    = document.querySelector('#fin-partido');

// Redibuja TODA la pantalla a partir del estado del partido.
// Un solo camino: cualquier cambio -> render(). Menos bugs.
function render() {
  const p = partido;

  // Cada panel muestra los datos de su equipo
  const datos = [[panelLocal, 0], [panelVisitante, 1]];
  for (const [panel, i] of datos) {
    panel.querySelector('.nombre-equipo').textContent = p.nombres[i];
    panel.querySelector('.puntos').textContent = p.puntos[i];
    panel.querySelector('.sets-ganados span').textContent = p.sets[i];
  }

  // Cambio de campo: la clase CSS "invertido" da la vuelta a los paneles
  paneles.classList.toggle('invertido', p.ladosInvertidos);

  const numSet = p.setsCerrados.length + 1;
  infoSet.textContent = p.terminado
    ? 'Partido terminado'
    : 'Set ' + numSet + ' · a ' + puntosObjetivo(p) + ' puntos';

  if (p.terminado) {
    const ganador = p.sets[0] > p.sets[1] ? 0 : 1;
    document.querySelector('#texto-ganador').textContent =
      '🏆 Gana ' + p.nombres[ganador] + ' (' + p.sets[0] + '-' + p.sets[1] + ')';
    document.querySelector('#resumen-sets').textContent =
      'Sets: ' + p.setsCerrados.join('  ·  ');
    finPartidoDiv.classList.remove('oculto');
  } else {
    finPartidoDiv.classList.add('oculto');
  }
}

// Aviso temporal arriba (como tus snackbars de Flutter)
let avisoTimer = null;
function mostrarAviso(texto) {
  avisoDiv.textContent = texto;
  avisoDiv.classList.remove('oculto');
  clearTimeout(avisoTimer);                    // si había un aviso, reinicia el reloj
  avisoTimer = setTimeout(function () {        // dentro de 3000 ms, ocúltalo
    avisoDiv.classList.add('oculto');
  }, 3000);
}

// ============================================================
// EVENTOS: conectar los botones con la lógica
// ============================================================

// Los tres botones de modalidad comparten la clase .btn-modalidad
for (const boton of document.querySelectorAll('.btn-modalidad')) {
  boton.addEventListener('click', function () {
    // "dataset.modalidad" lee el atributo data-modalidad del HTML
    const modalidad = boton.dataset.modalidad;
    // "|| 'Local'": si el campo está vacío, usamos un nombre por defecto
    const local     = document.querySelector('#nombre-local').value.trim() || 'Local';
    const visitante = document.querySelector('#nombre-visitante').value.trim() || 'Visitante';

    partido = nuevoPartido(modalidad, local, visitante);
    pantallaInicio.classList.add('oculto');
    pantallaMarcador.classList.remove('oculto');
    render();
  });
}

// Botones +1 y −1 de cada panel
panelLocal.querySelector('.btn-sumar').addEventListener('click', function () { sumarPunto(0); });
panelLocal.querySelector('.btn-restar').addEventListener('click', function () { restarPunto(0); });
panelVisitante.querySelector('.btn-sumar').addEventListener('click', function () { sumarPunto(1); });
panelVisitante.querySelector('.btn-restar').addEventListener('click', function () { restarPunto(1); });

document.querySelector('#btn-nuevo-partido').addEventListener('click', function () {
  pantallaMarcador.classList.add('oculto');
  pantallaInicio.classList.remove('oculto');
});

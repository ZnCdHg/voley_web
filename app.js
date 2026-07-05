// ============================================================
// APP — la pantalla: dibuja el estado y conecta los botones.
// La lógica del juego vive en partido.js (aquí solo se usa).
// ============================================================

// ----- Estado de la interfaz -----
let partido = null;
let desdeHistorial = false;   // ¿estamos viendo un partido del historial?
let vistaEvol = 'grafica';    // 'grafica' o 'puntos'
let setSeleccionado = 0;

// ----- Referencias a elementos del HTML -----
const panelLocal     = document.querySelector('#panel-local');
const panelVisitante = document.querySelector('#panel-visitante');
const paneles        = document.querySelector('#paneles');
const tiraVivo       = document.querySelector('#tira-vivo');
const infoSet        = document.querySelector('#info-set');
const avisoDiv       = document.querySelector('#aviso');
const finPartidoDiv  = document.querySelector('#fin-partido');
const overlayTm      = document.querySelector('#overlay-tm');

const NOMBRE_MODALIDAD = { '4v4': '4 vs 4', '6v6': '6 vs 6', 'playa': 'Playa' };

// ============================================================
// NAVEGACIÓN ENTRE PANTALLAS
// ============================================================

function mostrarPantalla(id) {
  for (const pantalla of document.querySelectorAll('.pantalla')) {
    pantalla.classList.toggle('oculto', pantalla.id !== id);
  }
}

// ============================================================
// UTILIDADES VISUALES
// ============================================================

// Dado un color de fondo, ¿el texto se lee mejor negro o blanco?
// (el mismo textoSobre() que pusimos en theme.dart de la app)
function textoSobre(hex) {
  const r = parseInt(hex.slice(1, 3), 16);   // "2f" en hexadecimal -> 47
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminancia = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminancia > 150 ? '#111111' : '#ffffff';
}

// Aviso temporal (snackbar)
let avisoTimer = null;
function mostrarAviso(texto) {
  avisoDiv.textContent = texto;
  avisoDiv.classList.remove('oculto');
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(function () {
    avisoDiv.classList.add('oculto');
  }, 3000);
}

// Conectamos la lógica con la pantalla: cuando partido.js quiera
// avisar de algo (set, cambio de campo), saldrá por nuestro snackbar.
alAvisar = mostrarAviso;

// Crea la ristra de cuadraditos de un set: cada cuadro es un punto,
// del color del equipo que lo anotó y con su tanteo dentro.
function crearCuadros(eventos, colores, tam) {
  const fragmento = document.createDocumentFragment();
  const marcador = [0, 0];
  for (const e of eventos) {
    marcador[e] += 1;
    const c = document.createElement('span');
    c.className = 'cuadro';
    c.style.width = tam + 'px';
    c.style.height = tam + 'px';
    c.style.lineHeight = tam + 'px';
    c.style.fontSize = Math.round(tam * 0.45) + 'px';
    c.style.background = colores[e];
    c.style.color = textoSobre(colores[e]);
    c.textContent = marcador[e];
    fragmento.appendChild(c);
  }
  return fragmento;
}

// ============================================================
// PANTALLA ENCENDIDA (Wake Lock, como wakelock_plus en Flutter)
// ============================================================

let wakeLock = null;

async function activarWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* si el navegador no deja, no pasa nada */ }
}

function liberarWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

// Al volver a la pestaña, el navegador suelta el wake lock: lo repedimos
document.addEventListener('visibilitychange', function () {
  const marcadorVisible = !document.querySelector('#pantalla-marcador').classList.contains('oculto');
  if (document.visibilityState === 'visible' && marcadorVisible && partido && !partido.terminado) {
    activarWakeLock();
  }
});

// ============================================================
// EL MARCADOR
// ============================================================

// Redibuja TODO el marcador a partir del estado del partido.
function render() {
  const p = partido;

  const datos = [[panelLocal, 0], [panelVisitante, 1]];
  for (const [panel, i] of datos) {
    panel.querySelector('.nombre-equipo').textContent = p.nombres[i];
    panel.querySelector('.sets-ganados span').textContent = p.sets[i];
    panel.style.borderTopColor = p.colores[i];

    const puntosDiv = panel.querySelector('.puntos');
    puntosDiv.textContent = p.puntos[i];
    puntosDiv.style.color = p.colores[i];

    const btnSumar = panel.querySelector('.btn-sumar');
    btnSumar.style.background = p.colores[i];
    btnSumar.style.color = textoSobre(p.colores[i]);

    const btnTm = panel.querySelector('.btn-tm');
    btnTm.textContent = 'TM (' + p.tmRestantes[i] + ')';
    btnTm.disabled = p.tmRestantes[i] === 0 || p.terminado;
  }

  paneles.classList.toggle('invertido', p.ladosInvertidos);

  // Tira de cuadraditos del set en curso
  tiraVivo.innerHTML = '';
  tiraVivo.appendChild(crearCuadros(p.eventosSetActual, p.colores, 20));

  const numSet = p.setsCerrados.length + 1;
  infoSet.textContent = p.terminado
    ? 'Partido terminado'
    : NOMBRE_MODALIDAD[p.modalidad] + ' · Set ' + numSet + ' · a ' + puntosObjetivo(p) + ' puntos';

  if (p.terminado) {
    const g = p.sets[0] > p.sets[1] ? 0 : 1;
    document.querySelector('#texto-ganador').textContent =
      '🏆 Gana ' + p.nombres[g] + ' (' + p.sets[0] + '-' + p.sets[1] + ')';
    document.querySelector('#resumen-sets').textContent =
      'Sets: ' + p.setsCerrados.join('  ·  ');
    finPartidoDiv.classList.remove('oculto');
    liberarWakeLock();   // partido acabado: la pantalla ya puede apagarse
  } else {
    finPartidoDiv.classList.add('oculto');
  }
}

// ----- Tiempo muerto con cuenta atrás de 30 s -----
let tmIntervalo = null;

function pedirTiempoMuerto(equipo) {
  if (!usarTiempoMuerto(partido, equipo)) return;
  render();

  document.querySelector('#tm-equipo').textContent = '⏱️ Tiempo muerto · ' + partido.nombres[equipo];
  const cuenta = document.querySelector('#tm-cuenta');
  let restante = 30;
  cuenta.textContent = restante;
  overlayTm.classList.remove('oculto');

  // setInterval ejecuta la función cada 1000 ms hasta que lo paremos
  tmIntervalo = setInterval(function () {
    restante -= 1;
    cuenta.textContent = restante;
    if (restante <= 0) cerrarTiempoMuerto();
  }, 1000);
}

function cerrarTiempoMuerto() {
  clearInterval(tmIntervalo);
  overlayTm.classList.add('oculto');
}

// ============================================================
// ESTADÍSTICAS
// ============================================================

function abrirStats(esHistorial) {
  desdeHistorial = esHistorial;
  const p = partido;
  const g = p.sets[0] > p.sets[1] ? 0 : 1;
  const t = puntosTotales(p);

  document.querySelector('#stats-titulo').textContent =
    '🏆 ' + p.nombres[g] + ' gana ' + p.sets[g] + '-' + p.sets[1 - g] + ' a ' + p.nombres[1 - g];
  document.querySelector('#stat-sets').textContent = p.setsCerrados.join(' · ');
  document.querySelector('#stat-puntos').textContent = t[0] + ' - ' + t[1];
  document.querySelector('#stat-racha').textContent = p.rachaMax[0] + ' / ' + p.rachaMax[1];
  document.querySelector('#stat-duracion').textContent = duracionTexto(p);

  const btnGuardar = document.querySelector('#btn-guardar');
  btnGuardar.disabled = p.guardado || esHistorial;
  btnGuardar.textContent = p.guardado || esHistorial ? '💾 Guardado' : '💾 Guardar';

  // Un botón por set jugado
  const selector = document.querySelector('#selector-sets');
  selector.innerHTML = '';
  p.eventosPorSet.forEach(function (_, i) {
    const b = document.createElement('button');
    b.textContent = 'Set ' + (i + 1);
    b.addEventListener('click', function () {
      setSeleccionado = i;
      renderEvolucion();
    });
    selector.appendChild(b);
  });

  setSeleccionado = 0;
  vistaEvol = 'grafica';
  renderEvolucion();
  mostrarPantalla('pantalla-stats');
}

function renderEvolucion() {
  const p = partido;

  // Marcar el botón de set y de vista activos
  document.querySelectorAll('#selector-sets button').forEach(function (b, i) {
    b.classList.toggle('activo', i === setSeleccionado);
  });
  document.querySelector('#btn-vista-grafica').classList.toggle('activo', vistaEvol === 'grafica');
  document.querySelector('#btn-vista-puntos').classList.toggle('activo', vistaEvol === 'puntos');

  const eventos = p.eventosPorSet[setSeleccionado] || [];
  document.querySelector('#evol-titulo').textContent =
    'Set ' + (setSeleccionado + 1) + '  (' + p.setsCerrados[setSeleccionado] + ')';

  const contGrafica = document.querySelector('#contenedor-grafica');
  const contPuntos = document.querySelector('#contenedor-puntos');
  contGrafica.classList.toggle('oculto', vistaEvol !== 'grafica');
  contPuntos.classList.toggle('oculto', vistaEvol !== 'puntos');

  if (vistaEvol === 'grafica') {
    dibujarGrafica(document.querySelector('#canvas-grafica'), eventos, p.colores);
  } else {
    contPuntos.innerHTML = '';
    contPuntos.appendChild(crearCuadros(eventos, p.colores, 30));
  }
}

// Dibuja en el canvas las dos líneas de puntos acumulados de un set.
// El canvas es como el CustomPainter de Flutter: nos da un contexto
// (ctx) con órdenes de dibujo: moveTo, lineTo, fillText...
function dibujarGrafica(canvas, eventos, colores) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const mIzq = 36, mDer = 34, mSup = 14, mInf = 24;
  ctx.clearRect(0, 0, W, H);

  // Series acumuladas: tras cada punto, cuántos lleva cada equipo
  const series = [[0], [0]];
  let a = 0, b = 0;
  for (const e of eventos) {
    if (e === 0) a += 1; else b += 1;
    series[0].push(a);
    series[1].push(b);
  }
  const maxY = Math.max(a, b, 5);
  const nX = Math.max(eventos.length, 1);

  // Funciones que traducen (nº de punto, tanteo) a píxeles del canvas
  const x = function (i) { return mIzq + (W - mIzq - mDer) * i / nX; };
  const y = function (v) { return H - mInf - (H - mSup - mInf) * v / maxY; };

  // Rejilla horizontal cada 5 puntos, con su etiqueta
  ctx.strokeStyle = 'rgba(140, 155, 170, 0.2)';
  ctx.fillStyle = '#9fb0c0';
  ctx.font = '12px sans-serif';
  ctx.lineWidth = 1;
  for (let v = 0; v <= maxY; v += 5) {
    ctx.beginPath();
    ctx.moveTo(mIzq, y(v));
    ctx.lineTo(W - mDer, y(v));
    ctx.stroke();
    ctx.fillText(v, 8, y(v) + 4);
  }

  // Las dos líneas, cada una del color de su equipo
  for (const equipo of [0, 1]) {
    const serie = series[equipo];
    ctx.strokeStyle = colores[equipo];
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    serie.forEach(function (v, i) {
      if (i === 0) ctx.moveTo(x(i), y(v));
      else ctx.lineTo(x(i), y(v));
    });
    ctx.stroke();
    // Tanteo final al extremo de cada línea
    ctx.fillStyle = colores[equipo];
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(serie[serie.length - 1], x(serie.length - 1) + 5, y(serie[serie.length - 1]) + 5);
  }
}

// ============================================================
// GUARDAR E HISTORIAL (localStorage: el "SQLite" del navegador)
// localStorage solo guarda texto, así que convertimos el partido
// a texto con JSON.stringify y lo recuperamos con JSON.parse.
// ============================================================

const CLAVE_HISTORIAL = 'voley_partidos';

function cargarGuardados() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_HISTORIAL)) || [];
  } catch (e) {
    return [];
  }
}

function guardarPartido() {
  if (partido.guardado) return;
  partido.guardado = true;
  const lista = cargarGuardados();
  lista.unshift({ guardadoEn: Date.now(), partido: partido });  // el más reciente, primero
  localStorage.setItem(CLAVE_HISTORIAL, JSON.stringify(lista));
  const btn = document.querySelector('#btn-guardar');
  btn.disabled = true;
  btn.textContent = '💾 Guardado';
  mostrarAviso('Partido guardado');
}

function abrirHistorial() {
  const lista = cargarGuardados();
  const cont = document.querySelector('#lista-partidos');
  cont.innerHTML = '';

  lista.forEach(function (item, i) {
    const p = item.partido;
    const div = document.createElement('div');
    div.className = 'partido-guardado';

    const resumen = document.createElement('div');
    resumen.className = 'resumen';
    const fecha = new Date(item.guardadoEn).toLocaleDateString('es-ES', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    resumen.innerHTML =
      '<strong>' + p.nombres[0] + ' ' + p.sets[0] + ' - ' + p.sets[1] + ' ' + p.nombres[1] + '</strong>' +
      '<div class="fecha">' + fecha + ' · ' + NOMBRE_MODALIDAD[p.modalidad] + ' · ' + p.setsCerrados.join(' · ') + '</div>';

    const btnVer = document.createElement('button');
    btnVer.textContent = 'Ver';
    btnVer.addEventListener('click', function () {
      partido = p;                 // el partido guardado pasa a ser el actual
      abrirStats(true);            // true = venimos del historial
    });

    const btnBorrar = document.createElement('button');
    btnBorrar.textContent = '🗑️';
    btnBorrar.className = 'btn-borrar';
    btnBorrar.addEventListener('click', function () {
      if (!confirm('¿Borrar este partido del historial?')) return;
      lista.splice(i, 1);          // quita 1 elemento en la posición i
      localStorage.setItem(CLAVE_HISTORIAL, JSON.stringify(lista));
      abrirHistorial();            // repinta la lista
    });

    div.appendChild(resumen);
    div.appendChild(btnVer);
    div.appendChild(btnBorrar);
    cont.appendChild(div);
  });

  mostrarPantalla('pantalla-historial');
}

// ============================================================
// COMPARTIR (texto y también imagen, como en la app)
// ============================================================

async function compartirTexto() {
  const texto = textoCompartir(partido);
  // navigator.share abre el menú nativo de compartir del móvil;
  // en ordenador no suele existir, así que copiamos al portapapeles.
  if (navigator.share) {
    try {
      await navigator.share({ text: texto });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;   // el usuario cerró el menú: no es un error
    }
  }
  try {
    await navigator.clipboard.writeText(texto);
    mostrarAviso('Resumen copiado al portapapeles');
  } catch (e) {
    mostrarAviso('No se pudo compartir');
  }
}

// Genera la imagen del partido en un canvas (como imagen_partido.dart)
function generarImagenPartido(p) {
  const W = 800, margen = 30;
  const lado = 22, hueco = 4;
  const porFila = Math.floor((W - margen * 2) / (lado + hueco));

  // Calculamos el alto según cuántas filas de cuadraditos salgan
  let H = 170;
  for (const ev of p.eventosPorSet) {
    H += 40 + Math.max(1, Math.ceil(ev.length / porFila)) * (lado + hueco);
  }
  H += margen;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#12181f';
  ctx.fillRect(0, 0, W, H);

  const g = p.sets[0] > p.sets[1] ? 0 : 1;
  const t = puntosTotales(p);
  ctx.fillStyle = '#e8edf2';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(p.nombres[0] + ' ' + p.sets[0] + ' - ' + p.sets[1] + ' ' + p.nombres[1], margen, 55);
  ctx.font = '17px sans-serif';
  ctx.fillStyle = '#9fb0c0';
  ctx.fillText('Gana ' + p.nombres[g] + ' · ' + NOMBRE_MODALIDAD[p.modalidad] + ' · ' + duracionTexto(p), margen, 90);
  ctx.fillText('Puntos totales ' + t[0] + '-' + t[1] + ' · Mayor racha ' + p.rachaMax[0] + '-' + p.rachaMax[1], margen, 115);

  let yy = 165;
  p.eventosPorSet.forEach(function (eventos, i) {
    ctx.fillStyle = '#e8edf2';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('Set ' + (i + 1) + '   ' + p.setsCerrados[i], margen, yy);
    yy += 12;

    const marcador = [0, 0];
    eventos.forEach(function (e, j) {
      marcador[e] += 1;
      const cx = margen + (j % porFila) * (lado + hueco);
      const cy = yy + Math.floor(j / porFila) * (lado + hueco);
      ctx.fillStyle = p.colores[e];
      ctx.fillRect(cx, cy, lado, lado);
      ctx.fillStyle = textoSobre(p.colores[e]);
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(marcador[e], cx + lado / 2, cy + lado / 2 + 4);
      ctx.textAlign = 'left';
    });
    yy += Math.max(1, Math.ceil(eventos.length / porFila)) * (lado + hueco) + 28;
  });

  return canvas;
}

function compartirImagen() {
  const canvas = generarImagenPartido(partido);
  // toBlob convierte el dibujo en un archivo PNG en memoria
  canvas.toBlob(async function (blob) {
    const archivo = new File([blob], 'partido.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
      try {
        await navigator.share({ files: [archivo] });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    // Sin menú de compartir (ordenador): descargamos el PNG
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = 'partido.png';
    enlace.click();
    URL.revokeObjectURL(enlace.href);
    mostrarAviso('Imagen descargada');
  });
}

// ============================================================
// EVENTOS: conectar los botones con todo lo anterior
// ============================================================

// Empezar partido
for (const boton of document.querySelectorAll('.btn-modalidad')) {
  boton.addEventListener('click', function () {
    const local     = document.querySelector('#nombre-local').value.trim() || 'Local';
    const visitante = document.querySelector('#nombre-visitante').value.trim() || 'Visitante';
    const colorL    = document.querySelector('#color-local').value;
    const colorV    = document.querySelector('#color-visitante').value;

    partido = nuevoPartido(boton.dataset.modalidad, local, visitante, colorL, colorV);
    mostrarPantalla('pantalla-marcador');
    activarWakeLock();
    render();
  });
}

// Botones de los dos paneles (0 = local, 1 = visitante)
const panelesEquipos = [[panelLocal, 0], [panelVisitante, 1]];
for (const [panel, equipo] of panelesEquipos) {
  panel.querySelector('.btn-sumar').addEventListener('click', function () {
    sumarPunto(partido, equipo);
    render();
  });
  panel.querySelector('.btn-restar').addEventListener('click', function () {
    restarPunto(partido, equipo);
    render();
  });
  panel.querySelector('.btn-tm').addEventListener('click', function () {
    pedirTiempoMuerto(equipo);
  });
}

// Salir del marcador a mitad de partido
document.querySelector('#btn-salir').addEventListener('click', function () {
  if (partido && !partido.terminado) {
    if (!confirm('¿Abandonar el partido? Se perderá el marcador.')) return;
  }
  liberarWakeLock();
  mostrarPantalla('pantalla-inicio');
});

// Fin de partido
document.querySelector('#btn-ver-stats').addEventListener('click', function () {
  abrirStats(false);
});
document.querySelector('#btn-nuevo-partido').addEventListener('click', function () {
  mostrarPantalla('pantalla-inicio');
});

// Estadísticas
document.querySelector('#btn-vista-grafica').addEventListener('click', function () {
  vistaEvol = 'grafica';
  renderEvolucion();
});
document.querySelector('#btn-vista-puntos').addEventListener('click', function () {
  vistaEvol = 'puntos';
  renderEvolucion();
});
document.querySelector('#btn-guardar').addEventListener('click', guardarPartido);
document.querySelector('#btn-compartir-texto').addEventListener('click', compartirTexto);
document.querySelector('#btn-compartir-imagen').addEventListener('click', compartirImagen);
document.querySelector('#btn-stats-volver').addEventListener('click', function () {
  if (desdeHistorial) abrirHistorial();
  else mostrarPantalla('pantalla-inicio');
});

// Historial
document.querySelector('#btn-ver-historial').addEventListener('click', abrirHistorial);
document.querySelector('#btn-historial-volver').addEventListener('click', function () {
  mostrarPantalla('pantalla-inicio');
});

// Tiempo muerto
document.querySelector('#btn-tm-fin').addEventListener('click', cerrarTiempoMuerto);

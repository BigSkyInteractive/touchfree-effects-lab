/*
WebGL 2 helpers for the Camera Feedback Effects engine. Every program is checked
when it is built: a shader that does not compile throws with the compiler's
message, so a preset that fails on this GPU backend is named, never a black
screen nobody can explain.
*/

export function floatPrecision(gl) {
  if (gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision > 0) return 'highp';
  if (gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT).precision > 0) return 'mediump';
  return 'lowp';
}

export function compileProgram(gl, vsSource, fsSource, label) {
  const prog = gl.createProgram();
  const parts = [[gl.VERTEX_SHADER, vsSource, 'vertex'], [gl.FRAGMENT_SHADER, fsSource, 'fragment']];
  const shaders = [];
  for (const [type, src, kind] of parts) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || '(no message)';
      gl.deleteShader(sh);
      gl.deleteProgram(prog);
      throw new Error(`${label} ${kind} shader did not compile:\n${log}`);
    }
    gl.attachShader(prog, sh);
    shaders.push(sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || '(no message)';
    gl.deleteProgram(prog);
    throw new Error(`${label} program did not link:\n${log}`);
  }
  for (const sh of shaders) gl.deleteShader(sh);
  return prog;
}

export function uniformLocations(gl, prog, names) {
  const out = {};
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
}

export function createTexture2D(gl, width, height, { wrap = gl.CLAMP_TO_EDGE, data = null, aniso = null } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                data || new Uint8Array(width * height * 4));
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (aniso) {
    gl.texParameterf(gl.TEXTURE_2D, aniso.ext.TEXTURE_MAX_ANISOTROPY_EXT, aniso.max);
  }
  return tex;
}

export function createTexture3D(gl, size, data) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_3D);
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

export function anisotropy(gl) {
  const ext = gl.getExtension('EXT_texture_filter_anisotropic') ||
              gl.getExtension('MOZ_EXT_texture_filter_anisotropic') ||
              gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
  if (!ext) return null;
  return { ext, max: gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) };
}

export function makeSampler(gl, { min, mag, wrap }) {
  const s = gl.createSampler();
  gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, min);
  gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, mag);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, wrap);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, wrap);
  return s;
}

export function attachToFramebuffer(gl, fb, tex) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
}

/* A unit quad in clip space, drawn as a triangle strip. */
export function quad(gl) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  return {
    draw(posLoc) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(posLoc);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

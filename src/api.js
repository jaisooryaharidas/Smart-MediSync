// All backend calls live here. Token is kept in localStorage.
export const getToken = () => localStorage.getItem('token');
export const setToken = t => (t ? localStorage.setItem('token', t) : localStorage.removeItem('token'));

export async function api(path, body, method) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(getToken() && { authorization: 'Bearer ' + getToken() }) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server. Is it running and are you online?');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && getToken()) { setToken(null); location.reload(); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// Shrink photos before upload (max 1600px JPEG) so requests stay small.
export function readImage(file) {
  return new Promise((ok, no) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return no(new Error('Unsupported file. Please choose a JPG, PNG or WebP image.'));
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = img.width * k; c.height = img.height * k;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); ok(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => no(new Error('This image could not be read.'));
    img.src = url;
  });
}

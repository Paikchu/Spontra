// Runs before first paint; blocked browser storage must not prevent rendering.
// Spontra is ink-first: without a saved choice the dark (ink) theme is used.
export const themeScript = `(function(){var m='dark';try{m=localStorage.getItem('max-investment-record:theme')||m}catch(e){}var d=m==='dark'||(m!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';var t=document.querySelector('meta[name="theme-color"]');if(t)t.content=d?'#0d1718':'#f6f7f4'})()`;


# Flat, outline-free tool drawings shared by the app and the website. Each is drawn upright, tip at the top.
SH = '#28190c'
def highlighter(body='#f2d64b', dark=None, ink=None):
    dark = dark or 'color-mix(in srgb, %s 78%%, #000)' % body
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 460"><g class="sh" fill="{SH}" opacity=".28" transform="translate(14 12)"><path d="M46 0L74 22V70H92V460H28V70H46Z"/></g>
<path d="M46 0L74 22V70H46Z" fill="{ink or body}"/><path d="M46 0V70H40V30Z" fill="{ink or body}" opacity=".7"/>
<rect x="30" y="66" width="60" height="44" fill="#5b5f66"/><rect x="60" y="66" width="30" height="44" fill="#474b51"/>
<rect x="24" y="108" width="72" height="352" rx="6" fill="{body}"/><path d="M60 108H90A6 6 0 0 1 96 114V460H60Z" fill="{dark}"/>
<rect x="38" y="150" width="10" height="250" rx="5" fill="#fff" opacity=".35"/></svg>'''
def tape():
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 460"><circle cx="246" cy="246" r="206" fill="{SH}" opacity=".26"/>
<path d="M60 150L-10 60H50L118 128Z" fill="#a8c3c8" opacity=".9"/>
<circle cx="230" cy="230" r="206" fill="#9dbbc1"/><path d="M376 84A206 206 0 0 1 84 376L230 230Z" fill="#86a7ad"/>
<circle cx="230" cy="230" r="150" fill="#b4ccd0"/><path d="M336 124A150 150 0 0 1 124 336L230 230Z" fill="#a1bec3"/>
<circle cx="230" cy="230" r="112" fill="#c9a06b"/><path d="M309 151A112 112 0 0 1 151 309L230 230Z" fill="#b18a58"/>
<circle cx="230" cy="230" r="92" fill="#6c5236"/></svg>'''
def ruler():
    ticks = ''.join(f'<rect x="{22 if i%5 else 0}" y="{24+i*17}" width="{22 if i%5 else 44}" height="3" fill="#6c5236"/>' for i in range(27))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 520"><rect x="22" y="14" width="120" height="506" fill="{SH}" opacity=".28"/>
<rect x="8" y="0" width="120" height="506" fill="#e7c98f"/><rect x="68" y="0" width="60" height="506" fill="#d6b578"/><g transform="translate(8 0)">{ticks}</g>
<circle cx="98" cy="470" r="10" fill="#b39467"/></svg>'''
def pencil():
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 500"><path d="M42 12L64 82V500H24V82Z" fill="{SH}" opacity=".28" transform="translate(12 8)"/>
<path d="M44 0L66 76H44Z" fill="#d6be91"/><path d="M44 0L22 76H44Z" fill="#ead6ae"/><path d="M44 0L50 22H38Z" fill="#3f352a"/>
<rect x="22" y="76" width="22" height="350" fill="#e3bf55"/><rect x="44" y="76" width="22" height="350" fill="#c9a544"/>
<rect x="22" y="426" width="44" height="26" fill="#b7bcc2"/><rect x="44" y="426" width="22" height="26" fill="#9ca2a9"/>
<rect x="22" y="452" width="44" height="48" rx="6" fill="#d9694a"/><path d="M44 452H60A6 6 0 0 1 66 458V500H44Z" fill="#bd5439"/></svg>'''

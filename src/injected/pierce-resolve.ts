// Shared browser-injected source: resolve an element by CSS selector while
// piercing light DOM → open shadow DOM → same-origin iframe.
//
// 背景 (form-mcp-dispatcher.ts の旧コメントより): fillForm だけが貫通解決を
//   持ち click/type/select_option は素の document.querySelector のままだったため、
//   shadow/iframe 内フォームで「入力はできたが送信ボタンが押せない」非対称が生じ、
//   confirm_reached に到達できず stall していた。貫通リゾルバを 1 ソースに集約し、
//   form-session-manager (fillForm) と form-mcp-dispatcher (click/type/select 等)
//   の両方から interpolate して使う。
//
// 重要: この文字列は executeJavaScript で実行される **純ブラウザ JS の関数式**。
//   TS 型注釈・backtick・${ } は使用不可。light DOM を最初に試すため後方互換。
export const PIERCE_RESOLVE_FN_SRC = `function(sel){
  var el=null; try{ el=document.querySelector(sel); }catch(e){}
  if(el) return el;
  function search(ctx, depth){
    if(depth > 8) return null; // 異常に深い shadow/iframe ネストでの stack overflow 防止
    var e=null; try{ e=ctx.querySelector(sel); }catch(_){}
    if(e) return e;
    var hosts; try{ hosts=ctx.querySelectorAll('*'); }catch(_){ hosts=[]; }
    for(var i=0;i<hosts.length;i++){ if(hosts[i].shadowRoot){ var r=search(hosts[i].shadowRoot, depth+1); if(r) return r; } }
    var fr; try{ fr=ctx.querySelectorAll('iframe'); }catch(_){ fr=[]; }
    for(var k=0;k<fr.length;k++){ try{ var fd=fr[k].contentDocument; if(fd){ var r2=search(fd, depth+1); if(r2) return r2; } }catch(_){} }
    return null;
  }
  return search(document, 0);
}`;

module.exports = { PIERCE_RESOLVE_FN_SRC };

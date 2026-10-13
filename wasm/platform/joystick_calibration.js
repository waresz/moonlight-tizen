/* Moonlight Tizen V10 controller profiles and calibration.
 * Per-slot profiles are applied in C++ before Limelight transmission.
 * Keep original mapping when correction is disabled.
 */
var JoystickCalibration = (function () {
  'use strict';
  var KEY='moonlight-joystick-profiles-v5', LEGACY='moonlight-joystick-calibration-v1';
  var names=['Cross (X)','Circle (O)','Square','Triangle','L1','R1','L2','R2','Share','Options','L3','R3','D-Pad Up','D-Pad Down','D-Pad Left','D-Pad Right','PS'];
  function defaults(){return {enabled:true,buttons:names.map(function(_,i){return i;}),centers:[0,0,0,0],minimums:[-1,-1,-1,-1],maximums:[1,1,1,1],deadzones:[0.08,0.08],invert:[false,false,false,false]};}
  function clone(o){return JSON.parse(JSON.stringify(o));}
  var store={profiles:[{name:'Default',settings:defaults()}],slots:[0,0,0,0]};
  try {
    var prior=JSON.parse(localStorage.getItem(KEY));
    if(prior&&Array.isArray(prior.profiles)&&prior.profiles.length&&Array.isArray(prior.slots)){store=prior;}
    else {var old=JSON.parse(localStorage.getItem(LEGACY));if(old&&old.centers&&old.buttons)store.profiles[0].settings=Object.assign(defaults(),old);}
  }catch(e){console.warn(e);}
  function persist(){try{localStorage.setItem(KEY,JSON.stringify(store));}catch(e){console.warn(e);}}
  function profile(slot){return store.profiles[store.slots[slot]||0]||store.profiles[0];}
  function cfg(slot){return profile(slot).settings;}
  var slot=0, modal=null, timer=null, capture=-1, focus=0, tab='profiles', identifying=false, pressedSnapshot=[], lastDetected=-1, mappingPhysical=-1, captureArmed=false, editMode='', focusedProfile=0, identifyExitLatch=false;
  function pads(){return navigator.getGamepads?navigator.getGamepads():[];}
  function pad(){return pads()[slot]||null;}
  function axis(id,i,v){var p=cfg(Math.min(3,Math.max(0,id||0)));if(!p.enabled||!Number.isFinite(v))return v;
    var center=Number(p.centers[i])||0,delta=v-center,travel=delta<0?center-p.minimums[i]:p.maximums[i]-center;
    var x=travel>=.12?Math.max(-1,Math.min(1,delta/travel)):0;
    var dz=Math.max(0,Math.min(.75,p.deadzones[Math.floor(i/2)]||0));x=Math.abs(x)<=dz?0:Math.sign(x)*(Math.abs(x)-dz)/(1-dz);
    return p.invert[i]?-x:x;
  }
  function sourceButton(id,target){var p=cfg(Math.min(3,Math.max(0,id||0)));return p.enabled?p.buttons[target]:target;}
  function status(t){var e=document.getElementById('jc-status');if(e)e.textContent=t;}
  function html(){var s=document.createElement('style');s.textContent=
    '#jc-v5{position:fixed;inset:0;z-index:99999;background:#0b1627;color:#eff6ff;font:19px Arial,sans-serif;display:none;padding:20px 3%;box-sizing:border-box}'+
    '#jc-v5 *{box-sizing:border-box}#jc-v5 button,#jc-v5 select{font:inherit;color:#fff;background:#233b56;border:1px solid #547ca5;border-radius:9px;padding:13px 16px;min-height:52px}'+
    '#jc-v5 button:focus,#jc-v5 select:focus{outline:4px solid #70c8ff}#jc-v5 .jc-head{display:flex;align-items:center;justify-content:space-between;gap:15px}'+
    '#jc-v5 .jc-tabs{display:flex;gap:12px;margin:14px 0}#jc-v5 .jc-tabs button.active{background:#166fa7}'+
    '#jc-v5 .jc-body{overflow-y:auto;max-height:calc(100vh - 195px);padding:8px 12px 32px;scroll-behavior:smooth}'+
    '#jc-v5 .jc-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:14px 0}#jc-v5 .jc-panel{background:#172c45;border:1px solid #314e6c;border-radius:14px;padding:20px;margin-bottom:14px}'+
    '#jc-v5 .jc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}#jc-v5 .jc-grid button{text-align:left}'+
    '#jc-v5 .jc-stick{position:relative;width:156px;height:156px;border:2px solid #6896ba;border-radius:50%;margin:12px}'+
    '#jc-v5 .jc-dot{position:absolute;top:68px;left:68px;width:16px;height:16px;border-radius:50%;background:#4de0ac}'+
    '#jc-v5 .jc-muted{color:#acc5de;font-size:16px}#jc-v5 .jc-highlight{color:#6ce8b9}'+
    '#jc-v5 .jc-detected{background:#087b9f!important;outline:3px solid #66e7ff!important;box-shadow:0 0 22px rgba(59,208,250,.48)}'+
    '#jc-v5 .jc-edit{display:grid;grid-template-columns:minmax(150px,1fr) 32px minmax(160px,1fr) 90px;align-items:center;gap:9px;padding:8px;border-bottom:1px solid #314e6c}'+
    '#jc-v5 .jc-edit button{padding:9px;min-height:45px}#jc-v5 input{font:inherit;color:#fff;background:#233b56;border:1px solid #547ca5;border-radius:9px;padding:12px;max-width:360px}'+
    '#jc-v5 .jc-state{border-radius:8px;background:#243c54;padding:12px;margin:12px 0}'+
    '#jc-v5 .jc-device-card{background:#213c59;border:2px solid #385c7b;border-radius:14px;padding:18px}#jc-v5 .jc-selected{border-color:#70c8ff}'+
    '#jc-v5 .jc-card-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}#jc-v5 .jc-card-title{font-weight:700;font-size:21px;margin-bottom:9px}'+
    '#jc-v5 .jc-waiting{border:2px solid #6be7ce;background:#12485b}#jc-v5 .jc-map-current{font-size:17px}'+
    '#jc-v5 .jc-profile-card{background:#213c59;border:2px solid #385c7b;border-radius:14px;padding:20px;margin:16px 0}'+
    '#jc-v5 .jc-overlay{position:absolute;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:rgba(3,10,20,.85)}'+
    '#jc-v5 .jc-dialog{background:#203750;border:2px solid #72bff6;border-radius:16px;padding:30px;width:min(720px,90%);box-shadow:0 25px 65px #0009}'+
    '#jc-v5 .jc-dialog p{line-height:1.5}#jc-v5 .jc-dialog button{min-width:135px}';
    document.head.appendChild(s);
    modal=document.createElement('div');modal.id='jc-v5';modal.innerHTML=
    '<div class="jc-head"><h2 style="margin:0">Joystick Calibration <small class="jc-muted">V11</small></h2><button id="jc-close">Close / Volver</button></div>'+
    '<div class="jc-tabs"><button data-tab="profiles">Profiles</button><button data-tab="mapping">Button Mapping</button><button data-tab="sticks">Sticks</button></div>'+
    '<div class="jc-body"><div id="jc-status" class="jc-muted">Detecting controller…</div><div id="jc-content"></div></div>';
    document.body.appendChild(modal);
    document.getElementById('jc-close').onclick=close;
    [].forEach.call(modal.querySelectorAll('[data-tab]'),function(b){b.onclick=function(){tab=b.dataset.tab;render();focusAt(1);};});
  }
  function dialog(message, onConfirm){
    var overlay=document.createElement('div');overlay.className='jc-overlay';
    var panel=document.createElement('div');panel.className='jc-dialog';
    var title=document.createElement('h3');title.textContent='Confirm action';panel.appendChild(title);
    var text=document.createElement('p');text.textContent=message;panel.appendChild(text);
    var row=document.createElement('div');row.className='jc-row';
    var cancel=document.createElement('button');cancel.textContent='Cancel';
    var accept=document.createElement('button');accept.textContent='Confirm';
    function dismiss(){overlay.remove();var b=document.getElementById('jc-new');if(b)b.focus();}
    cancel.onclick=dismiss;accept.onclick=function(){dismiss();onConfirm();};
    row.appendChild(cancel);row.appendChild(accept);panel.appendChild(row);
    overlay.appendChild(panel);modal.appendChild(overlay);cancel.focus();
  }
  function escapeText(s){return String(s).replace(/[&<>"]/g,function(x){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[x];});}
  function connectedList(){var result=[];var all=pads();for(var i=0;i<Math.min(4,all.length);i++)if(all[i]&&all[i].connected)result.push(i);return result;}
  function render(){if(!modal)return;var root=document.getElementById('jc-content'),p=cfg(slot);capture=-1;mappingPhysical=-1;captureArmed=false;pressedSnapshot=[];
    [].forEach.call(modal.querySelectorAll('[data-tab]'),function(b){b.className=b.dataset.tab===tab?'active':'';});
    if(tab==='profiles'){
      var connected=connectedList();root.innerHTML='<div class="jc-panel"><h3>Connected Controllers</h3><p class="jc-muted">Choose a profile for each controller. The profile manager below works independently of the selected controller.</p><div id="jc-devices" class="jc-grid"></div></div>'+ 
        '<div class="jc-panel"><h3>Manage Profiles</h3><p class="jc-muted">Manage one profile at a time with Previous / Next. This selection does not change any controller assignment.</p><button id="jc-new">+ Create profile</button><div id="jc-profiles"></div><p class="jc-muted">Changes save automatically. Reconnect streaming to apply them to Sunshine. LED customization is not supported by the standard Tizen Gamepad API.</p></div>';
      var list=document.getElementById('jc-devices');
      connected.forEach(function(i){var g=pads()[i],card=document.createElement('div');card.className='jc-device-card'+(i===slot?' jc-selected':'');
        var header=document.createElement('div');header.className='jc-card-title';header.textContent='Controller '+(i+1)+(i===slot?' · Selected':'');card.appendChild(header);
        var descriptor=document.createElement('p');descriptor.className='jc-muted';descriptor.textContent=g.id;card.appendChild(descriptor);
        var current=document.createElement('div');current.className='jc-state';current.textContent='Assigned profile: '+profile(i).name;card.appendChild(current);
        var actions=document.createElement('div');actions.className='jc-card-actions';
        function btn(label,callback){var b=document.createElement('button');b.textContent=label;b.onclick=callback;actions.appendChild(b);}
        btn('Select controller',function(){slot=i;render();});
        btn('◀ Previous profile',function(){store.slots[i]=((store.slots[i]||0)+store.profiles.length-1)%store.profiles.length;slot=i;persist();render();});
        btn('Next profile ▶',function(){store.slots[i]=((store.slots[i]||0)+1)%store.profiles.length;slot=i;persist();render();});
        btn('Correction: '+(cfg(i).enabled?'ON':'OFF'),function(){cfg(i).enabled=!cfg(i).enabled;slot=i;persist();render();});
        card.appendChild(actions);list.appendChild(card);
      });
      if(!connected.length)list.textContent='No controllers connected. Pair a joystick to assign a profile.';
      var container=document.getElementById('jc-profiles');
      // Profiles are managed separately from the currently selected controller.
      // Keep the selected profile index stable across controller selection changes.
      focusedProfile=Math.max(0,Math.min(focusedProfile,store.profiles.length-1));
      function redrawManager(){
        container.innerHTML='';
        var index=focusedProfile,item=store.profiles[index];
        var card=document.createElement('div');card.className='jc-profile-card';
        var title=document.createElement('div');title.className='jc-card-title';title.textContent='Profile '+(index+1)+' of '+store.profiles.length+': '+item.name;card.appendChild(title);
        var assigned=[];connectedList().forEach(function(id){if((store.slots[id]||0)===index)assigned.push('Controller '+(id+1));});
        var detail=document.createElement('p');detail.className='jc-muted';detail.textContent=assigned.length?'Assigned to: '+assigned.join(', '):'Not assigned to a connected controller';card.appendChild(detail);
        var actions=document.createElement('div');actions.className='jc-card-actions';
        function action(label,cb){var button=document.createElement('button');button.textContent=label;button.onclick=cb;actions.appendChild(button);return button;}
        action('◀ Previous profile',function(){focusedProfile=(focusedProfile+store.profiles.length-1)%store.profiles.length;redrawManager();});
        action('Next profile ▶',function(){focusedProfile=(focusedProfile+1)%store.profiles.length;redrawManager();});
        card.appendChild(actions);
        var editActions=document.createElement('div');editActions.className='jc-card-actions jc-row';
        function manage(label,cb){var button=document.createElement('button');button.textContent=label;button.onclick=cb;editActions.appendChild(button);return button;}
        manage('Rename',function(){nameEditor(index,'rename');});
        manage('Duplicate',function(){nameEditor(index,'clone');});
        manage('Reset',function(){dialog('Reset all mappings and stick calibration for "'+item.name+'"?',function(){item.settings=defaults();persist();redrawManager();});});
        var del=manage('Delete',function(){
          dialog('Delete profile "'+item.name+'"? Connected controllers using this profile will switch to Default.',function(){
            store.profiles.splice(index,1);
            store.slots=store.slots.map(function(n){return n===index?0:(n>index?n-1:n);});
            focusedProfile=Math.max(0,Math.min(index,store.profiles.length-1));
            persist();render();
          });
        });
        if(index===0||store.profiles.length<=1){del.disabled=true;del.title='Default is protected';}
        card.appendChild(editActions);container.appendChild(card);
      }
      function nameEditor(index,mode){
        var old=document.getElementById('jc-profile-editor');if(old)old.remove();
        var editor=document.createElement('div');editor.id='jc-profile-editor';editor.className='jc-state jc-row';
        var label=document.createElement('span');label.textContent=mode==='rename'?'Rename profile:':'Profile name:';
        var input=document.createElement('input');input.id='jc-name';input.type='text';input.maxLength=40;
        input.value=mode==='rename'?store.profiles[index].name:mode==='clone'?store.profiles[index].name+' Copy':'';
        var save=document.createElement('button');save.textContent='Save name';
        var cancel=document.createElement('button');cancel.textContent='Cancel';
        save.onclick=function(){var name=input.value.trim();if(!name){status('Enter a profile name');input.focus();return;}
          if(mode==='rename')store.profiles[index].name=name;
          else {store.profiles.push({name:name,settings:mode==='clone'?clone(store.profiles[index].settings):defaults()});focusedProfile=store.profiles.length-1;}
          persist();redrawManager();};
        cancel.onclick=function(){editor.remove();};
        editor.appendChild(label);editor.appendChild(input);editor.appendChild(save);editor.appendChild(cancel);
        container.appendChild(editor);
        // Tizen's onscreen keyboard may consume OK. When editing finishes,
        // explicitly release the text field and move focus to Save name.
        function finishTyping(){
          if(document.activeElement===input)input.blur();
          save.focus();
          if(save.scrollIntoView)save.scrollIntoView({block:'nearest'});
        }
        input.addEventListener('keydown',function(ev){
          var key=ev.key,code=ev.keyCode;
          if(key==='Enter'||key==='NumpadEnter'||code===13||key==='Tab'||code===9||key==='ArrowDown'||code===40){
            ev.preventDefault();ev.stopImmediatePropagation();finishTyping();
          }else if(key==='Escape'||key==='BrowserBack'||code===10009){
            ev.preventDefault();ev.stopImmediatePropagation();input.blur();cancel.focus();
          }
          // Backspace is intentionally left to the native Samsung keyboard.
        },true);
        input.addEventListener('change',function(){
          // Tizen virtual keyboard "Done" commonly commits with change/blur.
          // Do not save without explicit confirmation.
          if(document.activeElement===input)finishTyping();
        });
        input.focus();
      }
      document.getElementById('jc-new').onclick=function(){nameEditor(-1,'new');};
      redrawManager();
    }else if(tab==='mapping'){
      root.innerHTML='<div class="jc-panel"><h3>Button Mapping · '+profile(slot).name+'</h3><p class="jc-muted">Identify mode shows the RAW physical button that Samsung detects. Press Start and test your controller. Press L1 + R1 together to exit Identify mode. The list follows each detected button automatically. Use the Samsung remote to navigate.</p><div class="jc-row"><button id="jc-identify">Start Identify</button><button id="jc-map-reset">Restore default mapping</button></div><div id="jc-identify-status" class="jc-state">Identify is OFF. Select Edit, then press the physical button you want Sunshine to receive.</div></div><div class="jc-panel"><h3>Detected button → Sent to Sunshine</h3><div id="jc-map-list"></div></div>';
      identifying=false;lastDetected=-1;identifyExitLatch=false;
      document.getElementById('jc-identify').onclick=function(){identifying=!identifying;lastDetected=-1;identifyExitLatch=false;pressedSnapshot=(pad()&&pad().buttons||[]).map(function(b){return !!b.pressed;});this.textContent=identifying?'Stop Identify':'Start Identify';paintMapping();};
      document.getElementById('jc-map-reset').onclick=function(){if(identifying||mappingPhysical>=0)return;p.buttons=names.map(function(_,i){return i;});persist();paintMapping();};
      paintMapping();
    }else{
      root.innerHTML='<div class="jc-panel"><h3>Stick Calibration · '+profile(slot).name+'</h3><p class="jc-muted">Keep the stick untouched for Calibrate Center. For Measure Full Range, rotate along its entire outer edge, then Finish.</p><div class="jc-grid" id="jc-stick-panels"></div><div class="jc-row"><button id="jc-range-stop">Finish Range Capture</button><span id="jc-range-status" class="jc-highlight">Ready</span></div><p class="jc-muted">The displayed dot and corrected values use the saved calibration. Values are applied to streaming when you reconnect.</p></div>';
      var panels=document.getElementById('jc-stick-panels');['Left','Right'].forEach(function(label,i){var d=document.createElement('div');d.innerHTML='<h3>'+label+' stick</h3><div class="jc-stick" id="jc-stick-'+i+'"><span class="jc-dot"></span></div><div id="jc-axis-'+i+'" class="jc-muted"></div><div class="jc-row"><button data-center="'+i+'">Calibrate Center</button><button data-measure="'+i+'">Measure Full Range</button></div>';panels.appendChild(d);});
      [].forEach.call(root.querySelectorAll('[data-center]'),function(b){b.onclick=function(){var i=Number(b.dataset.center),g=pad();if(!g||g.axes.length<2*i+2){status('Controller axes unavailable');return;}p.centers[2*i]=g.axes[2*i];p.centers[2*i+1]=g.axes[2*i+1];persist();};});
      [].forEach.call(root.querySelectorAll('[data-measure]'),function(b){b.onclick=function(){var i=Number(b.dataset.measure),g=pad();if(!g||g.axes.length<2*i+2){status('Controller axes unavailable');return;}capture=i;for(var a=2*i;a<2*i+2;a++){p.minimums[a]=g.axes[a];p.maximums[a]=g.axes[a];}document.getElementById('jc-range-status').textContent='Capturing '+(i?'RIGHT':'LEFT')+' stick';};});
      document.getElementById('jc-range-stop').onclick=function(){capture=-1;persist();document.getElementById('jc-range-status').textContent='Saved. Restart stream to apply.';};
    }
  }
  function paintMapping(){var root=document.getElementById('jc-map-list');if(!root)return;root.innerHTML='';var p=cfg(slot);
    for(var physical=0;physical<names.length;physical++)(function(i){var output=p.buttons.indexOf(i);var row=document.createElement('div');row.className='jc-edit'+(mappingPhysical===i?' jc-waiting':'');row.dataset.physical=i;
      var physicalName=document.createElement('span');physicalName.textContent=names[i];physicalName.className='jc-physical';row.appendChild(physicalName);
      var arrow=document.createElement('span');arrow.textContent='→';row.appendChild(arrow);
      var sent=document.createElement('span');sent.textContent=names[output]||'Unassigned';sent.className=output===i?'jc-muted':'jc-highlight';row.appendChild(sent);
      var edit=document.createElement('button');edit.textContent=mappingPhysical===i?'Cancel':'Edit';edit.disabled=identifying;edit.onclick=function(){if(mappingPhysical===i){mappingPhysical=-1;captureArmed=false;}else{mappingPhysical=i;captureArmed=false;pressedSnapshot=(pad()&&pad().buttons||[]).map(function(b){return !!b.pressed;});}paintMapping();};row.appendChild(edit);root.appendChild(row);
    })(physical);
    var status=document.getElementById('jc-identify-status');if(status&&mappingPhysical>=0){status.textContent='Editing '+names[mappingPhysical]+' — release all buttons, then press the physical button for the desired Sunshine output. Saved automatically.';}else if(status)status.textContent=identifying?(lastDetected>=0?'Detected: '+names[lastDetected]+' (raw input)':'Identify ON — press a button · L1 + R1 together to exit'):'Identify OFF — choose Edit, then press the desired output button.';
    showDetected();
  }
  function applyMapping(physical,destination){var p=cfg(slot),current=p.buttons.indexOf(physical),other=p.buttons[destination];
    if(current<0||destination<0||destination>=names.length)return;
    p.buttons[destination]=physical;
    if(current!==destination)p.buttons[current]=other;
    mappingPhysical=-1;captureArmed=false;persist();paintMapping();status('Saved: '+names[physical]+' → '+names[destination]+'. Reconnect stream to apply.');
  }
  function handleMappingCapture(g){var current=g.buttons.map(function(b){return !!b.pressed;});
    if(!captureArmed){if(!current.some(Boolean))captureArmed=true;pressedSnapshot=current;return;}
    for(var i=0;i<Math.min(names.length,current.length);i++)if(current[i]&&!pressedSnapshot[i]){applyMapping(mappingPhysical,i);pressedSnapshot=current;return;}
    pressedSnapshot=current;
  }
  function showDetected(){var rows=document.querySelectorAll('#jc-map-list .jc-edit');[].forEach.call(rows,function(row){var ix=Number(row.dataset.physical);row.classList.toggle('jc-detected',identifying&&ix===lastDetected);});}
  function stopIdentify(){
    identifying=false;lastDetected=-1;identifyExitLatch=false;
    var control=document.getElementById('jc-identify');if(control)control.textContent='Start Identify';
    pressedSnapshot=[];paintMapping();
    var state=document.getElementById('jc-identify-status');if(state)state.textContent='Identify OFF — choose Edit to change a mapping.';
  }
  function scrollToDetected(index){
    var row=document.querySelector('#jc-map-list .jc-edit[data-physical="'+index+'"]');
    var body=modal&&modal.querySelector('.jc-body');
    if(!row||!body)return;
    // Scroll only the list container. Do not change keyboard focus during polling.
    var rowRect=row.getBoundingClientRect(),bodyRect=body.getBoundingClientRect();
    if(rowRect.top<bodyRect.top+12||rowRect.bottom>bodyRect.bottom-12){
      var target=body.scrollTop+(rowRect.top-bodyRect.top)-(body.clientHeight-rowRect.height)/2;
      body.scrollTop=Math.max(0,target);
    }
  }
  function handleIdentify(g){
    var current=g.buttons.map(function(b){return !!b.pressed;});
    // Standard Gamepad mapping: L1=4 and R1=5. Hold both to exit.
    if(current[4]&&current[5]){
      if(!identifyExitLatch){identifyExitLatch=true;stopIdentify();}
      return;
    }
    identifyExitLatch=false;
    var newly=-1;
    for(var i=0;i<Math.min(names.length,current.length);i++)if(current[i]&&!pressedSnapshot[i]){newly=i;break;}
    if(newly>=0){
      lastDetected=newly;
      var state=document.getElementById('jc-identify-status');
      if(state)state.textContent='Detected: '+names[newly]+' (raw Samsung input) · L1 + R1 to exit';
      scrollToDetected(newly);
    }else if(!current.some(function(v){return v;})){
      lastDetected=-1;
      var state2=document.getElementById('jc-identify-status');
      if(state2)state2.textContent='Identify ON — press a button · L1 + R1 together to exit';
    }
    pressedSnapshot=current;showDetected();
  }
  function poll(){var g=pad();status(g&&g.connected?'Controller '+(slot+1)+': '+g.id+' · '+g.axes.length+' axes / '+g.buttons.length+' buttons':'Controller '+(slot+1)+' disconnected');
    if(!g||!g.connected)return;
    if(tab==='mapping'&&identifying)handleIdentify(g);
    else if(tab==='mapping'&&mappingPhysical>=0)handleMappingCapture(g);
    if(tab==='sticks'){
      var p=cfg(slot);if(capture>=0){for(var a=capture*2;a<capture*2+2;a++){p.minimums[a]=Math.min(p.minimums[a],g.axes[a]);p.maximums[a]=Math.max(p.maximums[a],g.axes[a]);}}
      for(var i=0;i<2;i++){var node=document.querySelector('#jc-stick-'+i+' .jc-dot'),read=document.getElementById('jc-axis-'+i);if(!node||g.axes.length<=2*i+1)continue;var x=g.axes[i*2],y=g.axes[i*2+1],xx=axis(slot,i*2,x),yy=axis(slot,i*2+1,y);
        node.style.left=(68+xx*65)+'px';node.style.top=(68+yy*65)+'px';read.textContent='Raw '+x.toFixed(3)+', '+y.toFixed(3)+' · Corrected '+xx.toFixed(3)+', '+yy.toFixed(3);}
    }
  }
  function inputs(){return modal?Array.prototype.slice.call(modal.querySelectorAll('button, select')):[];}
  function focusAt(i){var list=inputs();if(!list.length)return;focus=Math.max(0,Math.min(list.length-1,i));list[focus].focus();if(list[focus].scrollIntoView)list[focus].scrollIntoView({block:'nearest'});}
  function navigate(k){if(mappingPhysical>=0)return;var list=inputs();var pos=list.indexOf(document.activeElement);if(pos>=0)focus=pos;var active=list[focus];if(k==='Enter'){if(active){if(active.tagName==='SELECT')return;active.click();}return;}focusAt(focus+((k==='ArrowDown'||k==='ArrowRight')?1:-1));}
  function isOpen(){return !!(modal&&modal.style.display!=='none');}
  function open(){if(!modal)html();modal.style.display='block';tab='profiles';render();if(timer)clearInterval(timer);timer=setInterval(poll,60);focusAt(0);}
  function close(){capture=-1;mappingPhysical=-1;identifying=false;if(timer)clearInterval(timer);timer=null;if(modal)modal.style.display='none';}
  window.addEventListener('keydown',function(e){if(!isOpen())return;var k=e.key,c=e.keyCode;if(modal.querySelector('.jc-overlay')){var overlay=modal.querySelector('.jc-overlay');if(k==='Escape'||c===10009){e.preventDefault();e.stopImmediatePropagation();var cancel=overlay.querySelector('button');if(cancel)cancel.click();return;}if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].indexOf(k)!==-1){e.preventDefault();e.stopImmediatePropagation();var options=Array.prototype.slice.call(overlay.querySelectorAll('button'));var idx=options.indexOf(document.activeElement);options[(idx+1)%options.length].focus();return;}if(k==='Enter'||c===13){e.preventDefault();e.stopImmediatePropagation();var act=document.activeElement;if(act&&overlay.contains(act))act.click();return;}return;}
    var typing=!!(e.target&&(/^(INPUT|TEXTAREA)$/).test(e.target.tagName));
    if(typing){
      // The input's own handler processes Done/Down; don't navigate the background.
      // Backspace, letters and IME composition must reach the native text editor.
      e.stopImmediatePropagation();return;
    }
    if(k==='Escape'||k==='BrowserBack'||c===10009){e.preventDefault();e.stopImmediatePropagation();if(mappingPhysical>=0){mappingPhysical=-1;captureArmed=false;paintMapping();}else if(identifying){identifying=false;paintMapping();var ib=document.getElementById('jc-identify');if(ib)ib.textContent='Start Identify';}else close();return;}
    if(k==='Up'||c===38)k='ArrowUp';else if(k==='Down'||c===40)k='ArrowDown';else if(k==='Left'||c===37)k='ArrowLeft';else if(k==='Right'||c===39)k='ArrowRight';else if(c===13)k='Enter';
    if(mappingPhysical>=0){if(k==='Enter'||k.indexOf('Arrow')===0){e.preventDefault();e.stopImmediatePropagation();return;}}
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter'].indexOf(k)!==-1){if(e.target&&e.target.tagName==='SELECT'&&k!=='Enter')return;e.preventDefault();e.stopImmediatePropagation();navigate(k);}
  },true);
  window.addEventListener('gamepadinputchanged',function(e){
    if(!isOpen())return;
    e.stopImmediatePropagation();
    if(identifying||mappingPhysical>=0||modal.querySelector('.jc-overlay')||!e.detail||!e.detail.changes)return;
    var active=document.activeElement;
    var typing=!!(active&&/^(INPUT|TEXTAREA)$/.test(active.tagName));
    e.detail.changes.forEach(function(change){
      if(change.type!=='button'||!change.pressed)return;
      if(typing){
        // Gamepad D-pad down/confirm exits name editing instead of trapping focus.
        if(change.index===13||change.index===0){
          var save=active.parentElement&&active.parentElement.querySelector('button');
          active.blur();if(save){save.focus();if(save.scrollIntoView)save.scrollIntoView({block:'nearest'});}
        }
        return;
      }
      var keys={0:'Enter',12:'ArrowUp',13:'ArrowDown',14:'ArrowLeft',15:'ArrowRight'};
      if(keys[change.index])navigate(keys[change.index]);
    });
  },true);
  function exportSettings(){var result=[];for(var i=0;i<4;i++){var p=cfg(i);result.push(p.enabled?1:0);result=result.concat(p.buttons,p.centers,p.deadzones,p.invert.map(function(v){return v?1:0;}),p.minimums,p.maximums);}return result.join(',');}
  return {open:open,close:close,isOpen:isOpen,axis:axis,sourceButton:sourceButton,exportSettings:exportSettings};
})();

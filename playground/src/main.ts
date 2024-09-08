import "./assets/main.css"
import { DatePicker } from "ant-design-vue"
import "ant-design-vue/dist/reset.css"
import { createApp } from "vue"
import { createPinia } from "pinia"

import App from "./App.vue"
import router from "./router"

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(DatePicker)

app.mount("#app")